//! 왕관 · 테이프 스티커 창 — 웹뷰 없이 미리 구운 그림 한 장 (stickers/*.png, render.mjs)
//!   Windows 층 창(layered)에 픽셀마다 투명도로 그린다: 투명한 곳은 마우스가 그대로 통과하고, 스티커 위에서만 손 모양 · 살짝 들림 · 누르면 떼어짐.
//!   창 자리 · 언제 띄우고 거둘지는 windows.rs 가 정한다. 여기 함수들은 UI 스레드에서 (windows.rs 의 ui() 로 부른다)
#![cfg_attr(not(windows), allow(dead_code))] // 그림 · 움직임 계산은 Linux 에서도 단위 테스트한다
use memoking_core::placement::Rect;
use std::sync::LazyLock;

/// 미리 곱한 투명도의 BGRA (Windows DIB 그대로)
#[derive(Clone)]
pub struct Image {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

fn decode(bytes: &[u8]) -> Image {
    let rgba = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).expect("스티커 그림 (render.mjs)").to_rgba8();
    let mut px = Vec::with_capacity(rgba.len());
    for p in rgba.pixels() {
        let [r, g, b, a] = p.0;
        let m = |c: u8| ((u32::from(c) * u32::from(a) + 127) / 255) as u8;
        px.extend([m(b), m(g), m(r), a]);
    }
    Image { w: rgba.width() as usize, h: rgba.height() as usize, px }
}

/// 넓이 평균으로 줄이기 (늘리기도 됨) — 미리 곱한 값이라 가장자리가 검게 번지지 않는다
pub fn resize(src: &Image, w: usize, h: usize) -> Image {
    // 한 축의 무게: 새 칸 i 가 원래 칸들을 얼마씩 덮는가
    fn weights(from: usize, to: usize) -> Vec<Vec<(usize, f32)>> {
        let step = from as f32 / to as f32;
        (0..to)
            .map(|i| {
                let (a, b) = (i as f32 * step, (i + 1) as f32 * step);
                let mut out = vec![];
                let mut j = a.floor() as usize;
                while (j as f32) < b && j < from {
                    let cover = (b.min(j as f32 + 1.0) - a.max(j as f32)).max(0.0);
                    if cover > 0.0 {
                        out.push((j, cover / step));
                    }
                    j += 1;
                }
                out
            })
            .collect()
    }
    let (wx, wy) = (weights(src.w, w), weights(src.h, h));
    let mut px = vec![0u8; w * h * 4];
    for (y, ry) in wy.iter().enumerate() {
        for (x, rx) in wx.iter().enumerate() {
            let mut acc = [0f32; 4];
            for &(sy, fy) in ry {
                for &(sx, fx) in rx {
                    let o = (sy * src.w + sx) * 4;
                    for (c, v) in acc.iter_mut().enumerate() {
                        *v += f32::from(src.px[o + c]) * fx * fy;
                    }
                }
            }
            let o = (y * w + x) * 4;
            for c in 0..4 {
                px[o + c] = acc[c].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Image { w, h, px }
}

static ART: LazyLock<[Image; 6]> = LazyLock::new(|| {
    [
        decode(include_bytes!("../stickers/crown.png")),
        decode(include_bytes!("../stickers/crown-hover.png")),
        decode(include_bytes!("../stickers/tape.png")),
        decode(include_bytes!("../stickers/tape-hover.png")),
        decode(include_bytes!("../stickers/tape-dark.png")),
        decode(include_bytes!("../stickers/tape-dark-hover.png")),
    ]
});

/// 그 스티커 그림 (크게 구운 원본)
pub fn art(kind: &str, dark: bool, hover: bool) -> &'static Image {
    let i = if kind == "tape" { 2 + 2 * usize::from(dark) } else { 0 };
    &ART[i + usize::from(hover)]
}

/// 사라지는 모습 — 떼어짐(위로 들리며) · 작은 왕관으로 들어감(아래로 작아지며)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Leave {
    Peel,
    Dock,
}

/// 움직임: (지난 시간 ms) → (불투명도 0~1, 위아래 어긋남 논리 px, 끝났나). stick=None 은 붙을 때
pub fn motion(leave: Option<Leave>, ms: f64, reduce: bool) -> (f64, f64, bool) {
    let ease = |t: f64| 1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(4); // art.css 의 cubic-bezier(0.23, 1, 0.32, 1) 에 가깝게
    match (leave, reduce) {
        (None, true) => (1.0, 0.0, true), // 움직임을 줄이면 붙을 때는 그냥 나타난다
        (None, false) => {
            let t = ms / 320.0;
            ((t / 0.55).min(1.0), -12.0 * (1.0 - ease(t)), t >= 1.0)
        }
        (Some(_), true) => {
            let t = ms / 160.0;
            (1.0 - t.min(1.0), 0.0, t >= 1.0) // 흐려지기만 (떼어졌다는 것은 보이게)
        }
        (Some(l), false) => {
            let (dur, dy) = if l == Leave::Peel { (200.0, -10.0) } else { (150.0, 8.0) };
            let t = ms / dur;
            (1.0 - ease(t), dy * ease(t), t >= 1.0)
        }
    }
}

/// 논리 자리 → 화면 픽셀 자리
pub fn physical([x, y, w, h]: Rect, scale: f64) -> [i32; 4] {
    [(x * scale).round() as i32, (y * scale).round() as i32, (w * scale).round().max(1.0) as i32, (h * scale).round().max(1.0) as i32]
}

#[cfg(windows)]
pub use win::{close, create, hwnd, place, rect, set_owner, shown};

#[cfg(windows)]
mod win {
    use super::{art, motion, physical, resize, Image, Leave};
    use memoking_core::placement::Rect;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, MutexGuard, OnceLock};
    use std::time::Instant;
    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, KillTimer, LoadCursorW, RegisterClassExW, SetCursor, SetTimer, SetWindowLongPtrW, ShowWindow, SystemParametersInfoW,
        UpdateLayeredWindow, GWLP_HWNDPARENT, GWLP_USERDATA, IDC_HAND, MA_NOACTIVATE, SPI_GETCLIENTAREAANIMATION, SW_SHOWNOACTIVATE, ULW_ALPHA, WM_DESTROY, WM_LBUTTONUP, WM_MOUSEACTIVATE,
        WM_MOUSEMOVE, WM_SETCURSOR, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    const WM_MOUSELEAVE: u32 = 0x02A3; // UI_Controls 기능을 켜지 않으려고
    const TIMER: usize = 1;
    const FRAME_MS: u32 = 16;

    struct St {
        hwnd: isize,
        kind: &'static str,
        dark: bool,
        hover: bool,
        /// 쉬는 자리 (논리) · 화면 배율
        rect: Rect,
        scale: f64,
        /// 움직임: (사라지는 모습 — None 은 붙는 중, 시작)
        anim: Option<(Option<Leave>, Instant)>,
        leaving: bool,
        /// 줄여 둔 그림 (원본 종류 · 크기가 같으면 다시 쓰지 않는다)
        cache: Option<((usize, usize, usize), Image)>,
    }

    static STICKERS: LazyLock<Mutex<HashMap<u64, St>>> = LazyLock::new(Mutex::default);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    fn all() -> MutexGuard<'static, HashMap<u64, St>> {
        STICKERS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    fn reduce_motion() -> bool {
        let mut on: i32 = 1;
        unsafe { SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, (&raw mut on).cast(), 0) };
        on == 0
    }

    fn class() -> *const u16 {
        static NAME: LazyLock<Vec<u16>> = LazyLock::new(|| wide("MemoKingSticker"));
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| unsafe {
            let wc = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(proc),
                hInstance: GetModuleHandleW(std::ptr::null()),
                lpszClassName: NAME.as_ptr(),
                ..std::mem::zeroed()
            };
            RegisterClassExW(&wc);
        });
        NAME.as_ptr()
    }

    /// 스티커 창을 만들어 띄운다 — owner: 주인 창(그 위에 머물고 함께 숨는다), rect: 논리 자리
    #[allow(clippy::too_many_arguments)]
    pub fn create(app: &AppHandle, id: u64, owner: i64, kind: &'static str, dark: bool, rect: Rect, scale: f64, animate: bool) {
        let _ = APP.set(app.clone());
        let [x, y, w, h] = physical(rect, scale);
        let h_ = unsafe {
            CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, class(), std::ptr::null(), WS_POPUP, x, y, w, h, owner as HWND, std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null())
        };
        if h_.is_null() {
            return;
        }
        unsafe { SetWindowLongPtrW(h_, GWLP_USERDATA, id as isize) };
        let anim = (animate && !reduce_motion()).then(|| (None, Instant::now()));
        all().insert(id, St { hwnd: h_ as isize, kind, dark, hover: false, rect, scale, anim, leaving: false, cache: None });
        present(id);
        unsafe {
            ShowWindow(h_, SW_SHOWNOACTIVATE);
            if anim.is_some() {
                SetTimer(h_, TIMER, FRAME_MS, None);
            }
        }
    }

    /// 주인 창을 따라 옮긴다
    pub fn place(id: u64, rect: Rect, scale: f64) {
        if let Some(s) = all().get_mut(&id) {
            s.rect = rect;
            s.scale = scale;
        }
        present(id);
    }

    /// 주인 창 바꾸기 (탭을 바꿀 때 스티커 창을 새 탭으로 넘긴다)
    pub fn set_owner(id: u64, owner: i64) {
        if let Some(h) = all().get(&id).map(|s| s.hwnd) {
            unsafe { SetWindowLongPtrW(h as HWND, GWLP_HWNDPARENT, owner as isize) };
        }
    }

    /// 거두기 — how 가 있으면 그 모습 뒤에
    pub fn close(id: u64, how: Option<Leave>) {
        if how.is_none() {
            let h = all().remove(&id).map(|s| s.hwnd);
            if let Some(h) = h {
                unsafe { DestroyWindow(h as HWND) };
            }
            return;
        }
        if let Some(s) = all().get_mut(&id) {
            s.leaving = true;
            s.hover = false;
            s.anim = Some((how, Instant::now()));
            unsafe { SetTimer(s.hwnd as HWND, TIMER, FRAME_MS, None) };
        }
    }

    /// 창 번호 (바탕화면 층 도우미에 테이프를 짝지어 알린다) — 아직 없으면 0
    pub fn hwnd(id: u64) -> i64 {
        all().get(&id).map_or(0, |s| s.hwnd as i64)
    }

    /// 떠 있는 (사라지는 중이 아닌) 스티커인가
    pub fn shown(id: u64) -> bool {
        all().get(&id).is_some_and(|s| !s.leaving)
    }

    /// 쉬는 자리 (논리) — 상태 말풍선이 피해 간다
    pub fn rect(id: u64) -> Option<Rect> {
        all().get(&id).filter(|s| !s.leaving).map(|s| s.rect)
    }

    /// 지금 모습으로 다시 그린다 → 움직임이 끝났나
    fn present(id: u64) -> bool {
        let mut g = all();
        let Some(s) = g.get_mut(&id) else { return true };
        let (alpha, dy, done) = s.anim.map_or((1.0, 0.0, true), |(how, t0)| motion(how, t0.elapsed().as_secs_f64() * 1000.0, reduce_motion()));
        let [x, y, w, h] = physical([s.rect[0], s.rect[1] + dy, s.rect[2], s.rect[3]], s.scale);
        let src = art(s.kind, s.dark, s.hover);
        let key = (src as *const Image as usize, w as usize, h as usize);
        if s.cache.as_ref().is_none_or(|(k, _)| *k != key) {
            s.cache = Some((key, resize(src, w as usize, h as usize)));
        }
        let img = &s.cache.as_ref().unwrap().1;
        let hwnd = s.hwnd as HWND;
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            let dc = CreateCompatibleDC(screen);
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB, ..std::mem::zeroed() };
            let mut bits = std::ptr::null_mut();
            let bmp = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            if !bmp.is_null() && !bits.is_null() {
                std::ptr::copy_nonoverlapping(img.px.as_ptr(), bits.cast::<u8>(), img.px.len());
                let old = SelectObject(dc, bmp);
                let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: (alpha * 255.0).round().clamp(0.0, 255.0) as u8, AlphaFormat: AC_SRC_ALPHA as u8 };
                let (pt, size, zero) = (POINT { x, y }, SIZE { cx: w, cy: h }, POINT { x: 0, y: 0 });
                UpdateLayeredWindow(hwnd, screen, &pt, &size, dc, &zero, 0, &blend, ULW_ALPHA);
                SelectObject(dc, old);
                DeleteObject(bmp);
            }
            DeleteDC(dc);
            ReleaseDC(std::ptr::null_mut(), screen);
        }
        if done {
            s.anim = None;
        }
        done
    }

    fn notify(id: u64, f: impl FnOnce(&AppHandle, u64) + Send + 'static) {
        if let Some(app) = APP.get().cloned() {
            std::thread::spawn(move || f(&app, id)); // 창 메시지 처리 안에서 다른 창을 건드리지 않게
        }
    }

    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        let id = unsafe { GetWindowLongPtrW(h, GWLP_USERDATA) } as u64;
        match msg {
            WM_MOUSEACTIVATE => return MA_NOACTIVATE as LRESULT,
            WM_SETCURSOR => {
                unsafe { SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_HAND)) };
                return 1;
            }
            WM_MOUSEMOVE | WM_MOUSELEAVE => {
                let over = msg == WM_MOUSEMOVE;
                let changed = all().get_mut(&id).filter(|s| !s.leaving && s.hover != over).map(|s| s.hover = over).is_some();
                if changed {
                    if over {
                        let mut t = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: h, dwHoverTime: 0 };
                        unsafe { TrackMouseEvent(&mut t) };
                    }
                    present(id);
                    notify(id, move |app, id| crate::windows::sticker_hover(app, id, over));
                }
                return 0;
            }
            WM_LBUTTONUP => {
                if shown(id) {
                    notify(id, crate::windows::sticker_clicked);
                }
                return 0;
            }
            WM_TIMER if wp == TIMER => {
                if present(id) {
                    unsafe { KillTimer(h, TIMER) };
                    let gone = all().get(&id).is_some_and(|s| s.leaving);
                    if gone {
                        all().remove(&id);
                        unsafe { DestroyWindow(h) };
                    }
                }
                return 0;
            }
            WM_DESTROY => {
                unsafe { KillTimer(h, TIMER) };
                // 주인 창과 함께 운영체제가 거둔 때도 잊는다 (다른 창이 같은 번호를 받으면 그 창을 건드리지 않게)
                let mine = all().get(&id).is_some_and(|s| s.hwnd == h as isize);
                if mine {
                    all().remove(&id);
                }
            }
            _ => {}
        }
        unsafe { DefWindowProcW(h, msg, wp, lp) }
    }
}

// Windows 밖(개발용 Linux 빌드)에는 스티커를 띄우지 않는다
#[cfg(not(windows))]
mod none {
    use super::Leave;
    use memoking_core::placement::Rect;
    use tauri::AppHandle;
    #[allow(clippy::too_many_arguments)]
    pub fn create(_: &AppHandle, _: u64, _: i64, _: &'static str, _: bool, _: Rect, _: f64, _: bool) {}
    pub fn place(_: u64, _: Rect, _: f64) {}
    pub fn set_owner(_: u64, _: i64) {}
    pub fn close(_: u64, _: Option<Leave>) {}
    pub fn hwnd(_: u64) -> i64 {
        0
    }
    pub fn shown(_: u64) -> bool {
        false
    }
    pub fn rect(_: u64) -> Option<Rect> {
        None
    }
}
#[cfg(not(windows))]
pub use none::{close, create, hwnd, place, rect, set_owner, shown};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn art_decodes_and_shrinks() {
        let crown = art("crown", false, false);
        assert_eq!((crown.w, crown.h), (256, 208), "4배로 구운 왕관 (render.mjs)");
        assert_eq!(art("tape", true, true).w, 384);
        let small = resize(crown, 80, 65); // 125%
        assert_eq!(small.px.len(), 80 * 65 * 4);
        // 모서리는 투명, 가운데는 왕관 (미리 곱한 값: 색은 투명도를 넘지 않는다)
        assert_eq!(small.px[3], 0);
        let mid = (32 * 80 + 40) * 4;
        assert!(small.px[mid + 3] > 150);
        assert!(small.px.as_chunks::<4>().0.iter().all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]));
        // 같은 크기는 그대로
        assert_eq!(resize(crown, 256, 208).px, crown.px);
    }

    #[test]
    fn stick_and_peel_motion() {
        assert_eq!(motion(None, 0.0, false), (0.0, -12.0, false));
        let (a, dy, done) = motion(None, 320.0, false);
        assert!((a - 1.0).abs() < 1e-9 && dy.abs() < 1e-9 && done);
        assert_eq!(motion(None, 0.0, true), (1.0, 0.0, true));
        let (a, dy, done) = motion(Some(Leave::Peel), 200.0, false);
        assert!(a.abs() < 1e-9 && (dy + 10.0).abs() < 1e-9 && done);
        assert_eq!(motion(Some(Leave::Dock), 80.0, true), (0.5, 0.0, false));
        assert_eq!(physical([10.2, 20.0, 64.0, 52.0], 1.5), [15, 30, 96, 78]);
    }
}
