//! 비밀 폴더 — app/js/core/secret-folders.js 와 같은 파일 모양 · 같은 암호 (PC · 휴대폰이 서로의 비밀 폴더를 연다)
//!   _memoking/secret/<폴더 id>/folder.json · <메모 id>.mks · <메모 id>.alarms.json · files/<무작위>.<확장자>.mks
//!   열쇠: PBKDF2-SHA256(비밀번호 NFC, 소금 16바이트, n 번) → 32바이트 → AES-256-GCM
use crate::memo_file::{self, Meta};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

pub const SECRET_DIR: &str = "_memoking/secret";
pub const ITERATIONS: u32 = 310_000;
const MIN_ITERATIONS: u32 = 1000;
const MAX_ITERATIONS: u32 = 2_000_000;
const VERSION: u64 = 1;
const CHECK: &str = "memoking-secret-folder";
const TEXT_TAG: &str = "mks1";
const BYTES_TAG: &[u8; 4] = b"MKS1";
/// 비밀 메모 본문에서 잠근 첨부를 가리키는 앞머리
pub const FILE_PREFIX: &str = "secret-file/";
/// 비밀 메모 id 앞머리 ("secret:<폴더>/<메모>")
pub const ID_PREFIX: &str = "secret:";
pub const WRONG_PASSWORD: &str = "비밀번호가 달라요";
pub const LOCKED: &str = "비밀 폴더가 잠겨 있어요. 비밀번호를 넣고 다시 해 주세요";

/// 연 비밀 폴더 — 연 동안만 들고 있는다
#[derive(Clone)]
pub struct Folder {
    pub key: [u8; 32],
    pub name: String,
}

// 열쇠는 기록 · 오류 글에 찍히지 않게
impl std::fmt::Debug for Folder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Folder").field("name", &self.name).finish_non_exhaustive()
    }
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0; N];
    getrandom::fill(&mut b).expect("난수를 만들지 못했어요");
    b
}

/// 파일 이름 · 폴더 id 로 쓸 무작위 글자 (bytes 바이트 → 16진수)
pub fn random_id(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).expect("난수를 만들지 못했어요");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 폴더 · 메모 id 꼴 (16진수 6~64자)
pub fn safe_id(s: &str) -> bool {
    (6..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 잠근 첨부 이름 꼴 ("<id>" 또는 "<id>.<확장자 1~8>")
pub fn safe_file(s: &str) -> bool {
    let (id, ext) = s.split_once('.').unwrap_or((s, ""));
    safe_id(id) && (s.len() == id.len() || ((1..=8).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())))
}

pub fn password_problem(password: &str) -> Option<&'static str> {
    crate::lock::password_problem(password)
}

fn derive(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0; 32];
    let pw: String = password.nfc().collect();
    pbkdf2::pbkdf2_hmac::<Sha256>(pw.as_bytes(), salt, iterations, &mut key);
    key
}

/// 글 → "mks1.<IV>.<암호문>" (저장마다 새 IV)
pub fn seal_text(text: &str, key: &[u8; 32]) -> String {
    let iv = random::<12>();
    let data = Aes256Gcm::new_from_slice(key).unwrap().encrypt(Nonce::from_slice(&iv), text.as_bytes()).expect("잠그지 못했어요");
    format!("{TEXT_TAG}.{}.{}", B64.encode(iv), B64.encode(data))
}

/// 잠근 글 → 글 (열쇠가 다르거나 망가졌으면 None)
pub fn open_text(sealed: &str, key: &[u8; 32]) -> Option<String> {
    let mut parts = sealed.trim().split('.');
    let (tag, iv, data) = (parts.next()?, parts.next()?, parts.next()?);
    if tag != TEXT_TAG || iv.is_empty() || data.is_empty() {
        return None;
    }
    let iv = B64.decode(iv).ok().filter(|v| v.len() == 12)?;
    let plain = Aes256Gcm::new_from_slice(key).ok()?.decrypt(Nonce::from_slice(&iv), B64.decode(data).ok()?.as_slice()).ok()?;
    String::from_utf8(plain).ok()
}

/// 바이트 → "MKS1" + IV(12) + 암호문
pub fn seal_bytes(bytes: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let iv = random::<12>();
    let data = Aes256Gcm::new_from_slice(key).unwrap().encrypt(Nonce::from_slice(&iv), bytes).expect("잠그지 못했어요");
    [BYTES_TAG.as_slice(), &iv, &data].concat()
}

/// 잠근 바이트 → 바이트 (열쇠가 다르거나 망가졌으면 None)
pub fn open_bytes(b: &[u8], key: &[u8; 32]) -> Option<Vec<u8>> {
    if b.len() < 32 || &b[..4] != BYTES_TAG {
        return None;
    }
    Aes256Gcm::new_from_slice(key).ok()?.decrypt(Nonce::from_slice(&b[4..16]), &b[16..]).ok()
}

/// 새 비밀 폴더 → (folder.json 에 쓸 기록, 연 폴더)
pub fn new_record(name: &str, password: &str, iterations: u32) -> Result<(Value, Folder), String> {
    let clean = memo_file::clean_folder_name(name);
    if clean.is_empty() {
        return Err("폴더 이름으로 쓸 수 없어요".into());
    }
    if let Some(p) = password_problem(password) {
        return Err(p.into());
    }
    let salt = random::<16>();
    let key = derive(password, &salt, iterations);
    let record = json!({ "v": VERSION, "n": iterations, "s": B64.encode(salt), "check": seal_text(CHECK, &key), "name": seal_text(&clean, &key) });
    Ok((record, Folder { key, name: clean }))
}

/// 폴더 기록을 비밀번호로 연다 (다르면 Err(WRONG_PASSWORD))
pub fn unlock_record(record: &Value, password: &str) -> Result<Folder, String> {
    const BROKEN: &str = "비밀 폴더 정보가 망가졌어요";
    if !record.is_object() {
        return Err(BROKEN.into());
    }
    if record["v"].as_u64() != Some(VERSION) {
        return Err("이 메모킹보다 새 버전에서 만든 비밀 폴더예요. 메모킹을 업데이트해 주세요".into());
    }
    // 파일에 적힌 반복 횟수를 그대로 믿지 않는다
    let n = record["n"].as_u64().filter(|n| (MIN_ITERATIONS as u64..=MAX_ITERATIONS as u64).contains(n)).ok_or(BROKEN)? as u32;
    let salt = record["s"].as_str().and_then(|s| B64.decode(s).ok()).ok_or(BROKEN)?;
    let key = derive(password, &salt, n);
    if open_text(record["check"].as_str().unwrap_or_default(), &key).as_deref() != Some(CHECK) {
        return Err(WRONG_PASSWORD.into());
    }
    let name = open_text(record["name"].as_str().unwrap_or_default(), &key).unwrap_or_else(|| "비밀 폴더".into());
    Ok(Folder { key, name })
}

/// 이름만 바꾼 기록
pub fn renamed_record(record: &Value, key: &[u8; 32], name: &str) -> Result<(Value, String), String> {
    let clean = memo_file::clean_folder_name(name);
    if clean.is_empty() {
        return Err("폴더 이름으로 쓸 수 없어요".into());
    }
    let mut next = record.clone();
    next["name"] = seal_text(&clean, key).into();
    Ok((next, clean))
}

pub fn memo_id(fid: &str, mid: &str) -> String {
    format!("{ID_PREFIX}{fid}/{mid}")
}

/// "secret:<폴더>/<메모>" → (폴더, 메모)
pub fn parse_id(id: &str) -> Option<(&str, &str)> {
    let (fid, mid) = id.strip_prefix(ID_PREFIX)?.split_once('/')?;
    (safe_id(fid) && safe_id(mid)).then_some((fid, mid))
}

pub fn is_secret_id(id: &str) -> bool {
    parse_id(id).is_some()
}

/// 잠기지 않는 알림 파일에 둘 것: 켜 둔 · 끝내지 않은 일정의 때만 (이름은 뺀다)
pub fn alarm_reminders(meta: &Meta) -> Vec<Value> {
    meta.reminders
        .iter()
        .filter(|r| r["enabled"] != Value::Bool(false) && !r["done"].as_bool().unwrap_or(false) && r.is_object())
        .map(|r| {
            let mut o = r.as_object().unwrap().clone();
            o.shift_remove("title");
            Value::Object(o)
        })
        .collect()
}

/// 본문에서 잠근 첨부 주소들
pub fn secret_files(body: &str) -> Vec<String> {
    crate::body::extract_media(body).into_iter().map(|m| m.src).filter(|s| s.starts_with(FILE_PREFIX)).collect()
}

// ---------- 경로 (메모 폴더 기준) ----------
pub fn folder_dir(fid: &str) -> String {
    format!("{SECRET_DIR}/{fid}")
}
pub fn record_path(fid: &str) -> String {
    format!("{SECRET_DIR}/{fid}/folder.json")
}
pub fn memo_path(fid: &str, mid: &str) -> String {
    format!("{SECRET_DIR}/{fid}/{mid}.mks")
}
pub fn alarms_path(fid: &str, mid: &str) -> String {
    format!("{SECRET_DIR}/{fid}/{mid}.alarms.json")
}
/// 본문의 "secret-file/<이름>" → 잠근 첨부 경로 (꼴이 다르면 None)
pub fn file_path(fid: &str, src: &str) -> Option<String> {
    let name = src.strip_prefix(FILE_PREFIX).filter(|n| safe_file(n))?;
    Some(format!("{SECRET_DIR}/{fid}/files/{name}.mks"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_bytes_roundtrip_and_wrong_key() {
        let (_, a) = new_record("일기", "비밀번호1", 1000).unwrap();
        let (_, b) = new_record("일기", "비밀번호1", 1000).unwrap();
        let s = seal_text("안녕 비밀", &a.key);
        assert!(s.starts_with("mks1.") && !s.contains("안녕"));
        assert_eq!(open_text(&s, &a.key).as_deref(), Some("안녕 비밀"));
        assert_eq!(open_text(&s, &b.key), None);
        let sb = seal_bytes(&[1, 2, 3, 250], &a.key);
        assert_eq!(open_bytes(&sb, &a.key), Some(vec![1, 2, 3, 250]));
        assert_eq!(open_bytes(&sb, &b.key), None);
        assert_eq!(open_bytes(&[1, 2, 3], &a.key), None);
    }

    #[test]
    fn record_unlock() {
        let (record, _) = new_record("가족 사진", "abcd1234", 1000).unwrap();
        assert!(!record.to_string().contains("가족"));
        assert_eq!(unlock_record(&record, "nope1234").err().as_deref(), Some(WRONG_PASSWORD));
        assert_eq!(unlock_record(&record, "abcd1234").unwrap().name, "가족 사진");
        let mut bad = record.clone();
        bad["n"] = 1_000_000_000u64.into();
        assert!(unlock_record(&bad, "abcd1234").unwrap_err().contains("망가졌어요"));
        assert!(new_record("x", "123", 1000).unwrap_err().contains("4자 이상"));
    }

    #[test]
    fn ids_and_paths() {
        assert_eq!(parse_id("secret:abcdef12/0123456789"), Some(("abcdef12", "0123456789")));
        assert_eq!(parse_id("secret:../x"), None);
        assert_eq!(parse_id("abc"), None);
        assert_eq!(file_path("abcdef", "secret-file/0a1b2c3d.png").as_deref(), Some("_memoking/secret/abcdef/files/0a1b2c3d.png.mks"));
        assert_eq!(file_path("abcdef", "secret-file/../../x.png"), None);
        assert_eq!(file_path("abcdef", "attachments/a.png"), None);
    }

    /// JS(app/js/core/secret-folders.js)가 만든 비밀 폴더를 연다 — 두 플랫폼이 같은 파일을 읽는지
    #[test]
    fn opens_js_made_folder() {
        let record: Value = serde_json::from_str(include_str!("../tests/fixtures/secret-folder.json")).unwrap();
        let f = unlock_record(&record, "pass1234").unwrap();
        assert_eq!(f.name, "일기장");
        let memo = open_text(include_str!("../tests/fixtures/secret-memo.mks"), &f.key).unwrap();
        let (meta, body) = memo_file::parse_memo_file(&memo);
        assert_eq!(meta.color, "pink");
        assert!(body.contains("첫 고백"));
        let bytes = include_bytes!("../tests/fixtures/secret-file.bin.mks");
        assert_eq!(open_bytes(bytes, &f.key), Some(vec![137, 80, 78, 71, 9, 8, 7]));
        // 잠갔다 풀면 그대로
        assert_eq!(open_text(&seal_text(&memo, &f.key), &f.key).as_deref(), Some(memo.as_str()));
    }
}
