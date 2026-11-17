//! 잠금 메모 암호 — app/js/core/memo-lock.js 와 같은 파일 모양 · 같은 암호
//!   PBKDF2-SHA256(비밀번호 NFC, 소금 16바이트, n 번) → 32바이트 열쇠 → AES-256-GCM(IV 12바이트, 암호문 뒤에 태그)
use crate::body::{self, LOCK, UNTITLED};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub const LOCK_VERSION: &str = "v1";
pub const LOCK_ITERATIONS: u32 = 310_000;
const MIN_ITERATIONS: u32 = 1000;
const MAX_ITERATIONS: u32 = 2_000_000;
pub const LOCKED_TITLE: &str = "잠긴 메모";
const LOCK_NOTICE: &str = "🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.";

/// 비밀번호로 만든 열쇠 — 메모를 연 동안만 들고 있는다
#[derive(Clone)]
pub struct Session {
    pub key: [u8; 32],
    pub salt: String,
    pub iterations: u32,
}

pub struct Locked {
    pub version: String,
    pub iterations: u32,
    pub salt: String,
    pub iv: String,
    pub data: String,
}

pub fn parse_locked(body: &str) -> Option<Locked> {
    let m = LOCK.captures(body).ok()??;
    Some(Locked { version: m[1].into(), iterations: m[2].parse().ok()?, salt: m[3].into(), iv: m[4].into(), data: m[5].into() })
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0; N];
    getrandom::fill(&mut b).expect("난수를 만들지 못했어요");
    b
}

fn derive(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0; 32];
    let pw: String = password.nfc().collect();
    pbkdf2::pbkdf2_hmac::<Sha256>(pw.as_bytes(), salt, iterations, &mut key);
    key
}

pub fn password_problem(password: &str) -> Option<&'static str> {
    (password.encode_utf16().count() < 4).then_some("비밀번호는 4자 이상으로 정해 주세요")
}

/// 새로 잠글 때의 열쇠 (새 소금) — 느리다(일부러), 부르는 쪽이 다른 스레드에서
pub fn new_session(password: &str, iterations: u32) -> Result<Session, String> {
    if let Some(p) = password_problem(password) {
        return Err(p.into());
    }
    let salt = random::<16>();
    Ok(Session { key: derive(password, &salt, iterations), salt: B64.encode(salt), iterations })
}

/// 잠긴 메모 열기: 비밀번호가 맞으면 (풀린 글, 열쇠)
pub fn open_lock(locked: &str, password: &str) -> Result<(String, Session), String> {
    let p = parse_locked(locked).ok_or("잠긴 메모가 아니에요")?;
    if p.version != LOCK_VERSION {
        return Err("이 메모킹보다 새 버전에서 잠근 메모예요. 메모킹을 업데이트해 주세요".into());
    }
    // 파일에 적힌 반복 횟수를 그대로 믿지 않는다 (몇 시간씩 멈추거나 영영 못 열지 않게)
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&p.iterations) {
        return Err("잠금 정보가 망가진 메모예요. 열 수 없어요. 다른 기기의 같은 메모나 이전 버전에서 되살려 보세요".into());
    }
    let salt = B64.decode(&p.salt).map_err(|_| "잠금 정보가 망가진 메모예요")?;
    let session = Session { key: derive(password, &salt, p.iterations), salt: p.salt, iterations: p.iterations };
    let plain = unseal(locked, &session).ok_or("비밀번호가 달라요")?;
    Ok((plain, session))
}

/// 열쇠로 잠근 본문 (저장마다 새 IV). hide_title: 제목도 숨긴다 ("잠긴 메모")
pub fn seal(plain: &str, s: &Session, hide_title: bool) -> String {
    let iv = random::<12>();
    let data = Aes256Gcm::new_from_slice(&s.key).unwrap().encrypt(Nonce::from_slice(&iv), plain.as_bytes()).expect("잠그지 못했어요");
    let title = if hide_title { String::new() } else { body::extract_title(plain) };
    let head = if title.is_empty() || title == UNTITLED { LOCKED_TITLE.to_string() } else { title.trim_start_matches('#').trim_start_matches(crate::js::is_space).to_string() };
    format!("# {head}\n\n{LOCK_NOTICE}\n\n<!-- memoking-lock {LOCK_VERSION} n={} s={} i={} c={} -->\n", s.iterations, s.salt, B64.encode(iv), B64.encode(data))
}

/// 열쇠로 푼 본문. 열쇠가 맞지 않으면(다른 비밀번호로 다시 잠금 등) None
pub fn unseal(locked: &str, s: &Session) -> Option<String> {
    let p = parse_locked(locked)?;
    if p.salt != s.salt || p.iterations != s.iterations {
        return None;
    }
    let iv = B64.decode(&p.iv).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let plain = Aes256Gcm::new_from_slice(&s.key).ok()?.decrypt(Nonce::from_slice(&iv), B64.decode(&p.data).ok()?.as_slice()).ok()?;
    String::from_utf8(plain).ok()
}

/// 잠긴 메모가 쓰는 첨부의 표 하나 — "소금\n경로" 의 SHA-256 앞 20자 (경로는 드러나지 않는다)
pub fn lock_ref_key(src: &str, salt: &str) -> String {
    let h = Sha256::digest(format!("{salt}\n{src}").as_bytes());
    h.iter().map(|b| format!("{b:02x}")).collect::<String>()[..20].to_string()
}

/// 잠근 글과 그 풀린 글로 머리말에 적을 표들
pub fn lock_refs(plain: &str, locked: &str) -> Vec<String> {
    let Some(p) = parse_locked(locked) else { return vec![] };
    let mut out: Vec<String> = vec![];
    for m in body::extract_media(plain) {
        let k = lock_ref_key(&m.src, &p.salt);
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_unseal_roundtrip() {
        let s = new_session("비밀번호1", 1000).unwrap();
        let locked = seal("# 비밀\n![](attachments/a.png) 내용", &s, false);
        assert!(body::is_locked_body(&locked) && locked.starts_with("# 비밀\n\n🔒"));
        assert_eq!(unseal(&locked, &s).as_deref(), Some("# 비밀\n![](attachments/a.png) 내용"));
        let (plain, again) = open_lock(&locked, "비밀번호1").unwrap();
        assert_eq!(plain, "# 비밀\n![](attachments/a.png) 내용");
        assert_eq!(again.key, s.key);
        assert_eq!(open_lock(&locked, "틀림틀림").err().as_deref(), Some("비밀번호가 달라요"));
        assert!(seal("비밀", &s, true).starts_with("# 잠긴 메모\n"));
        assert_eq!(lock_refs("![](attachments/a.png)", &locked).len(), 1);
        assert!(new_session("짧", 1000).is_err());
    }
}
