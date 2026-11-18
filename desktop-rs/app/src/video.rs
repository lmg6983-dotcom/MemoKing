// 휴대폰 동영상(HEVC · H.265): WebView2 는 Windows 의 "HEVC 비디오 확장"이 있어야 푼다 (Electron 은 스스로 풀었다).
//   그 확장이 없는 PC 에서는 함께 넣은 작은 ffmpeg 로 H.264 사본을 이 PC 에만 만들어 그것을 보낸다 (메모 폴더 밖이라 동기화되지 않는다).
//   만드는 동안은 503 으로 바로 실패시키고 media:converting, 다 되면 media:ready (메모 속 경로). 화면이 그때 다시 부른다 (editor.js · video-poster.js)
use crate::state::state;
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};

const CACHE_LIMIT: u64 = 2 << 30; // 사본은 모두 2GB 까지 (넘으면 오래된 것부터 지운다)

static RUNNING: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default); // 만드는 중인 사본
static FAILED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(Default::default); // 이번 실행에서 못 만든 사본 (다시 하지 않는다)

/// 이 PC 에서 재생할 파일: 원본, 또는 HEVC 면 H.264 사본. None = 사본을 만드는 중 (503)
pub fn playable(app: &AppHandle, rel: &str, file: PathBuf) -> Option<PathBuf> {
    if has_hevc_decoder() || !is_hevc(&file) {
        return Some(file);
    }
    let Some(ffmpeg) = ffmpeg_path(app) else { return Some(file) };
    let Some(key) = cache_key(&file) else { return Some(file) };
    let out = cache_dir(app).join(format!("{key}.mp4"));
    // 사본은 RUNNING 에서 빠지기 전에 제 이름이 되므로, 이 잠금 안에서는 "있음" 과 "만드는 중" 이 함께 틀리지 않는다
    let mut running = RUNNING.lock().unwrap();
    if out.is_file() {
        return Some(out);
    }
    if FAILED.lock().unwrap().contains(&out) {
        return Some(file);
    }
    if running.insert(out.clone()) {
        let (app, rel) = (app.clone(), rel.to_string());
        std::thread::spawn(move || {
            if let Err(e) = convert(&ffmpeg, &file, &out) {
                eprintln!("[video] {rel}: {e}");
                FAILED.lock().unwrap().insert(out.clone());
            }
            RUNNING.lock().unwrap().remove(&out);
            let _ = app.emit("media:ready", rel); // 못 만들었어도 알린다: 화면이 원본으로 다시 해 보고 오류를 보이게
        });
    }
    drop(running);
    let _ = app.emit("media:converting", rel);
    None
}

/// 사본 이름: 원본 경로 · 크기 · 고친 시각 (원본이 바뀌면 새 사본)
fn cache_key(file: &Path) -> Option<String> {
    use sha2::Digest;
    let m = std::fs::metadata(file).ok()?;
    let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let hash = sha2::Sha256::digest(format!("{}\n{}\n{mtime}", file.display(), m.len()));
    Some(hash[..12].iter().map(|b| format!("{b:02x}")).collect())
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    let st = state(app);
    let base = if crate::ipc::smoke() { st.settings_dir.clone() } else { app.path().local_data_dir().map(|d| d.join("MemoKing")).unwrap_or_else(|_| st.settings_dir.clone()) };
    base.join("video-cache")
}

/// ffmpeg: MEMOKING_FFMPEG, 설치본의 resources\ffmpeg, 개발 중이면 desktop/vendor/ffmpeg (desktop-rs/scripts/build-ffmpeg-min.sh)
fn ffmpeg_path(app: &AppHandle) -> Option<PathBuf> {
    let name = format!("ffmpeg{}", std::env::consts::EXE_SUFFIX);
    let candidates = [
        std::env::var_os("MEMOKING_FFMPEG").map(PathBuf::from),
        app.path().resource_dir().ok().map(|d| d.join("ffmpeg").join(&name)),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../desktop/vendor/ffmpeg").join(&name)),
    ];
    candidates.into_iter().flatten().find(|p| p.is_file())
}

/// 다른 이름으로 만들고 다 되면 바꾼다: 반쯤 만든 사본을 보내지 않게
fn convert(ffmpeg: &Path, src: &Path, out: &Path) -> Result<(), String> {
    let dir = out.parent().ok_or("사본 폴더 없음")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    trim_cache(dir);
    let part = out.with_extension("part");
    let mut cmd = std::process::Command::new(ffmpeg);
    // h264_mf: Windows 에 든 H.264 인코더. 10비트(HDR) 영상은 그 인코더가 받는 nv12 로, 4K 는 1920 안으로 줄인다 (메모 속 재생에 넉넉)
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(src);
    cmd.args(["-map", "0:v:0", "-map", "0:a?", "-vf", "scale='min(iw,1920)':'min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=nv12"]);
    cmd.args(["-c:v", "h264_mf", "-b:v", "8M", "-c:a", "copy", "-movflags", "+faststart", "-f", "mp4"]).arg(&part);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    let res = cmd.spawn().map_err(|e| e.to_string()).and_then(|child| {
        #[cfg(windows)]
        crate::ai::kill_with_app(&child);
        let o = child.wait_with_output().map_err(|e| e.to_string())?;
        if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
    });
    let res = res.and_then(|()| std::fs::rename(&part, out).map_err(|e| e.to_string()));
    if res.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    res
}

/// 사본이 한도를 넘으면 오래된 것부터 지운다
fn trim_cache(dir: &Path) {
    let mut files: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.metadata().ok()?.len(), e.path()))).collect();
    files.sort();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    for (_, len, path) in files {
        if total <= CACHE_LIMIT {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// mp4 · mov 의 영상 트랙이 HEVC 인가: 상자(box) 머리만 읽으며 moov › trak › mdia › minf › stbl › stsd 의 첫 항목 이름을 본다
///   moov 는 파일 앞에도 끝에도 있을 수 있어 건너뛰며 찾는다 (영상 자체는 읽지 않는다)
fn is_hevc(file: &Path) -> bool {
    std::fs::File::open(file).ok().and_then(|mut f| {
        let len = f.metadata().ok()?.len();
        hevc_in(&mut f, 0, len, 0)
    }) == Some(true)
}

fn hevc_in(f: &mut (impl Read + Seek), mut at: u64, end: u64, depth: u8) -> Option<bool> {
    while at + 8 <= end {
        let mut head = [0u8; 16];
        f.seek(SeekFrom::Start(at)).ok()?;
        f.read_exact(&mut head[..8]).ok()?;
        let (mut size, kind) = (u32::from_be_bytes(head[..4].try_into().ok()?) as u64, <[u8; 4]>::try_from(&head[4..8]).ok()?);
        let mut body = at + 8;
        if size == 1 {
            f.read_exact(&mut head[8..16]).ok()?;
            size = u64::from_be_bytes(head[8..16].try_into().ok()?);
            body += 8;
        } else if size == 0 {
            size = end - at; // 파일 끝까지
        }
        if size < body - at || at + size > end {
            return None;
        }
        match &kind {
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" if depth < 5 => {
                if hevc_in(f, body, at + size, depth + 1)? {
                    return Some(true);
                }
            }
            b"stsd" => {
                // 판/플래그 4 · 항목 수 4 · 첫 항목 크기 4 · 첫 항목 이름 4 (Dolby Vision 은 dvh1/dvhe 지만 속은 HEVC)
                let mut e = [0u8; 16];
                f.read_exact(&mut e).ok()?;
                if matches!(&e[12..16], b"hvc1" | b"hev1" | b"dvh1" | b"dvhe") {
                    return Some(true);
                }
            }
            _ => {}
        }
        at += size;
    }
    Some(false)
}

/// Windows 에 HEVC 를 푸는 소프트웨어 MFT 가 있는가 (= "HEVC 비디오 확장"을 깔았다). 실행마다 한 번 본다
///   그래픽 드라이버가 넣는 하드웨어 MFT 는 세지 않는다. 그것만으로는 WebView2 가 HEVC 를 풀지 않는다
#[cfg(windows)]
fn has_hevc_decoder() -> bool {
    use windows::Win32::Media::MediaFoundation::*;
    static HAS: LazyLock<bool> = LazyLock::new(|| {
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_HEVC };
        let (mut list, mut n) = (std::ptr::null_mut::<Option<IMFActivate>>(), 0u32);
        // SAFETY: 받은 배열의 n 개를 놓고(Release) 배열은 CoTaskMemFree 로 돌려준다
        unsafe {
            if MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), None, &mut list, &mut n).is_err() {
                return false;
            }
            for i in 0..n as usize {
                std::ptr::drop_in_place(list.add(i));
            }
            windows::Win32::System::Com::CoTaskMemFree(Some(list as _));
        }
        n > 0
    });
    *HAS
}

// 다른 운영체제의 웹뷰는 제 코덱으로 (사본을 만들지 않는다)
#[cfg(not(windows))]
fn has_hevc_decoder() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::hevc_in;
    use std::io::Cursor;

    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        [&((body.len() + 8) as u32).to_be_bytes()[..], kind, body].concat()
    }

    fn movie(codec: &[u8; 4]) -> Vec<u8> {
        let stsd = mp4_box(b"stsd", &[&[0u8; 4][..], &1u32.to_be_bytes(), &mp4_box(codec, &[0; 8])].concat());
        let stbl = mp4_box(b"stbl", &stsd);
        mp4_box(b"moov", &mp4_box(b"trak", &mp4_box(b"mdia", &mp4_box(b"minf", &stbl))))
    }

    fn check(file: &[u8]) -> Option<bool> {
        hevc_in(&mut Cursor::new(file), 0, file.len() as u64, 0)
    }

    #[test]
    fn finds_hevc_track_wherever_moov_is() {
        let ftyp = mp4_box(b"ftyp", b"isom");
        let mdat = mp4_box(b"mdat", &[7; 64]);
        assert_eq!(check(&[&ftyp[..], &movie(b"hvc1"), &mdat].concat()), Some(true));
        assert_eq!(check(&[&ftyp[..], &mdat, &movie(b"hev1")].concat()), Some(true));
        assert_eq!(check(&[&ftyp[..], &mdat, &movie(b"avc1")].concat()), Some(false));
        // 64비트 크기 mdat 뒤의 moov
        let big = [&1u32.to_be_bytes()[..], b"mdat", &(16u64 + 4).to_be_bytes(), &[0; 4]].concat();
        assert_eq!(check(&[&ftyp[..], &big, &movie(b"hvc1")].concat()), Some(true));
        // 깨진 크기는 HEVC 가 아닌 것으로 (원본 그대로 보낸다)
        assert_eq!(check(&[&ftyp[..], &[0, 0, 0, 3], b"moov"].concat()), None);
        assert_eq!(check(&include_bytes!("../smoke-clip.mp4")[..]), Some(false));
        assert_eq!(check(&include_bytes!("../smoke-clip-hevc.mp4")[..]), Some(true));
    }
}
