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

/// CSS cubic-bezier(x1, y1, x2, y2) — t(0~1) → 진행
pub fn bezier((x1, y1, x2, y2): (f64, f64, f64, f64), t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    let at = |a: f64, b: f64, u: f64| 3.0 * a * u * (1.0 - u).powi(2) + 3.0 * b * u * u * (1.0 - u) + u.powi(3);
    // x(u) = t 인 u 를 반으로 나눠 찾는다 (x 는 늘 커진다)
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..30 {
        let mid = (lo + hi) / 2.0;
        if at(x1, x2, mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    at(y1, y2, (lo + hi) / 2.0)
}
/// art.css 의 움직임 곡선 (부드럽게 멈춤) · 마우스 올림 transition: ease-out
const SNAP: (f64, f64, f64, f64) = (0.23, 1.0, 0.32, 1.0);
const EASE_OUT: (f64, f64, f64, f64) = (0.0, 0.0, 0.58, 1.0);
/// 떼어질 때 · 들어갈 때의 움직임 (easeOutCubic) — SNAP 은 0.2초 중 첫 0.04초에 70% 를 가 사라짐이 툭 끊겨 보였다
const GLIDE: (f64, f64, f64, f64) = (0.33, 1.0, 0.68, 1.0);
pub const HOVER_MS: f64 = 150.0;
pub const PEEL_MS: f64 = 320.0;
pub const DOCK_MS: f64 = 240.0;

/// 투명도는 처음과 끝을 부드럽게 (smoothstep) — 한 장면 사이에 크게 바뀌지 않게
fn fade(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 2D 변환 (x, y) → (a x + c y + e, b x + d y + f)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine([f64; 6]);

impl Affine {
    const ID: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    fn then(self, o: Self) -> Self {
        // self 를 먼저, 그다음 o
        let [a, b, c, d, e, f] = self.0;
        let [p, q, r, s, t, u] = o.0;
        Self([p * a + r * b, q * a + s * b, p * c + r * d, q * c + s * d, p * e + r * f + t, q * e + s * f + u])
    }
    fn inverse(self) -> Self {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        Self([ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)])
    }
    pub fn apply(self, (x, y): (f64, f64)) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }
}

/// CSS transform: translateY(ty) rotate(deg) scale(k), transform-origin (ox, oy) — 논리 px, 그림 상자 기준
pub fn css((ox, oy): (f64, f64), ty: f64, deg: f64, k: f64) -> Affine {
    let (sin, cos) = deg.to_radians().sin_cos();
    let mv = |x: f64, y: f64| Affine([1.0, 0.0, 0.0, 1.0, x, y]);
    mv(-ox, -oy).then(Affine([k, 0.0, 0.0, k, 0.0, 0.0])).then(Affine([cos, sin, -sin, cos, 0.0, 0.0])).then(mv(ox, oy + ty))
}

/// 한 순간의 모습: 불투명도 · 변환 (그림 상자 기준) · 끝났나
#[derive(Debug)]
pub struct Pose {
    pub opacity: f64,
    pub transform: Affine,
    pub done: bool,
}

/// 붙고(leave=None) 떼어지고 들어가는 모습 — art.css 의 @keyframes 그대로. w·h: 그림 상자 (논리 px)
pub fn pose(kind: &str, leave: Option<Leave>, ms: f64, reduce: bool, (w, h): (f64, f64)) -> Pose {
    let at = |fx: f64, fy: f64| (w * fx, h * fy);
    let crown = kind != "tape";
    match (leave, reduce) {
        (None, true) => Pose { opacity: 1.0, transform: Affine::ID, done: true }, // 움직임을 줄이면 붙을 때는 그냥 나타난다
        (Some(_), true) => {
            let t = (ms / 160.0).min(1.0);
            Pose { opacity: 1.0 - t, transform: Affine::ID, done: t >= 1.0 } // 흐려지기만 (떼어졌다는 것은 보이게)
        }
        // sticker-stick 0.32s: 0% { opacity 0; translateY(-12px) rotate(-12deg) scale(1.16) } 100% { none } — 투명도는 80% 까지 부드럽게 (art.css 는 55% 라 툭 나타났다)
        (None, false) => {
            let t = (ms / 320.0).min(1.0);
            let p = bezier(SNAP, t);
            let origin = if crown { at(0.5, 0.7) } else { at(0.5, 0.6) };
            Pose { opacity: fade(t / 0.8), transform: css(origin, -12.0 * (1.0 - p), -12.0 * (1.0 - p), 1.16 - 0.16 * p), done: t >= 1.0 }
        }
        // sticker-peel: to { opacity 0; translateY(-10px) rotate(10deg) scale(1.08) } — 길이 · 곡선은 GLIDE 참고
        (Some(Leave::Peel), false) => {
            let t = (ms / PEEL_MS).min(1.0);
            let p = bezier(GLIDE, t);
            let origin = if crown { at(0.3, 0.8) } else { at(0.5, 0.6) };
            Pose { opacity: 1.0 - fade(t), transform: css(origin, -10.0 * p, 10.0 * p, 1.0 + 0.08 * p), done: t >= 1.0 }
        }
        // sticker-dock: to { opacity 0; translateY(8px) scale(0.4) } (제목 줄 작은 왕관 쪽으로)
        (Some(Leave::Dock), false) => {
            let t = (ms / DOCK_MS).min(1.0);
            let p = bezier(GLIDE, t);
            Pose { opacity: 1.0 - fade(t), transform: css(at(0.5, 0.8), 8.0 * p, 0.0, 1.0 - 0.6 * p), done: t >= 1.0 }
        }
    }
}

/// 마우스를 올렸을 때 들린 모습 (.crown.hover · .tape.hover) — hover 그림(render.mjs)이 이 변환으로 구워져 있다
pub fn lift(kind: &str, t: f64, (w, h): (f64, f64)) -> Affine {
    if kind == "tape" {
        css((w * 0.5, h * 0.6), -t, -2.0 * t, 1.0)
    } else {
        css((w * 0.3, h * 0.8), -2.0 * t, -4.0 * t, 1.0)
    }
}

/// 마우스 올림 진행 (0 쉼 ~ 1 들림): from 에서 시작해 target 으로 HOVER_MS 동안
pub fn hover_progress(from: f64, target: bool, ms: f64, reduce: bool) -> f64 {
    let to = if target { 1.0 } else { 0.0 };
    if reduce {
        return to;
    }
    from + (to - from) * bezier(EASE_OUT, ms / HOVER_MS)
}

/// 움직이는 스티커가 잘리지 않게 창을 그림 상자보다 이만큼(논리 px) 넓게
pub const PAD: f64 = 18.0;

/// 그림 상자 [x, y, w, h] → 둘레를 넓힌 창 자리 (논리)
pub fn padded([x, y, w, h]: Rect) -> Rect {
    [x - PAD, y - PAD, w + 2.0 * PAD, h + 2.0 * PAD]
}

fn sample(img: &Image, x: f64, y: f64) -> [f32; 4] {
    // 겹선형 (미리 곱한 값) — 그림 밖은 투명
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = ((x - x0) as f32, (y - y0) as f32);
    let px = |xi: f64, yi: f64| -> [f32; 4] {
        if xi < 0.0 || yi < 0.0 || xi >= img.w as f64 || yi >= img.h as f64 {
            return [0.0; 4];
        }
        let o = (yi as usize * img.w + xi as usize) * 4;
        [f32::from(img.px[o]), f32::from(img.px[o + 1]), f32::from(img.px[o + 2]), f32::from(img.px[o + 3])]
    };
    let (a, b, c, d) = (px(x0, y0), px(x0 + 1.0, y0), px(x0, y0 + 1.0), px(x0 + 1.0, y0 + 1.0));
    std::array::from_fn(|i| (a[i] * (1.0 - fx) + b[i] * fx) * (1.0 - fy) + (c[i] * (1.0 - fx) + d[i] * fx) * fy)
}

/// 한 장 그리기: 쉬는 그림 · 들린 그림(hover, 0~1 만큼 섞음)을 변환해 둘레 넓힌 판에 — 판 크기 (cw, ch) 화면 px
///   rest · lifted 는 그림 상자를 화면 배율로 줄여 둔 것, baked: lifted 가 구워진 들림 변환. transform 은 그림 상자 논리 px 기준
#[allow(clippy::too_many_arguments)]
pub fn render(rest: &Image, lifted: &Image, baked: Affine, hover: f64, transform: Affine, (w, h): (f64, f64), scale: f64, (cw, ch): (usize, usize)) -> Image {
    let (kx, ky) = (rest.w as f64 / w, rest.h as f64 / h); // 논리 px → 그림 px
    let back = transform.inverse();
    let mut px = vec![0u8; cw * ch * 4];
    for y in 0..ch {
        for x in 0..cw {
            // 판의 화소 가운데 → 그림 상자 논리 좌표 → 변환 전 자리
            let p = ((x as f64 + 0.5) / scale - PAD, (y as f64 + 0.5) / scale - PAD);
            let (ex, ey) = back.apply(p);
            let mut v = if hover < 1.0 { sample(rest, ex * kx - 0.5, ey * ky - 0.5) } else { [0.0; 4] };
            if hover > 0.0 {
                // 들린 그림은 이미 들린 자리에 그려져 있다 — 같은 내용이 같은 곳에 오게 들림 변환을 한 번 더 거쳐 읽는다
                let (lx, ly) = baked.apply((ex, ey));
                let l = sample(lifted, lx * kx - 0.5, ly * ky - 0.5);
                for i in 0..4 {
                    v[i] = v[i] * (1.0 - hover as f32) + l[i] * hover as f32;
                }
            }
            let o = (y * cw + x) * 4;
            for i in 0..4 {
                px[o + i] = v[i].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Image { w: cw, h: ch, px }
}

/// 논리 자리 → 화면 픽셀 자리
pub fn physical([x, y, w, h]: Rect, scale: f64) -> [i32; 4] {
    [(x * scale).round() as i32, (y * scale).round() as i32, (w * scale).round().max(1.0) as i32, (h * scale).round().max(1.0) as i32]
}

#[cfg(windows)]
pub use win::{close, create, hwnd, place, rect, set_owner, shown};

#[cfg(windows)]
mod win {
    use super::{art, hover_progress, lift, padded, physical, pose, render, resize, Image, Leave, HOVER_MS};
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
        /// 마우스 올림이 바뀐 때 · 그때의 들림 정도 (0~1, 그사이는 HOVER_MS 동안 부드럽게)
        hover_at: Instant,
        hover_from: f64,
        /// 그림 상자 자리 (논리) · 화면 배율
        rect: Rect,
        scale: f64,
        /// 움직임: (사라지는 모습 — None 은 붙는 중, 시작)
        anim: Option<(Option<Leave>, Instant)>,
        leaving: bool,
        /// 화면 배율로 줄여 둔 쉬는 그림 · 들린 그림 (크기가 같으면 다시 쓰지 않는다)
        cache: Option<((usize, usize), Image, Image)>,
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
        let [x, y, w, h] = physical(padded(rect), scale);
        let h_ = unsafe {
            CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, class(), std::ptr::null(), WS_POPUP, x, y, w, h, owner as HWND, std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null())
        };
        if h_.is_null() {
            return;
        }
        unsafe { SetWindowLongPtrW(h_, GWLP_USERDATA, id as isize) };
        let anim = (animate && !reduce_motion()).then(|| (None, Instant::now()));
        all().insert(id, St { hwnd: h_ as isize, kind, dark, hover: false, hover_at: Instant::now(), hover_from: 0.0, rect, scale, anim, leaving: false, cache: None });
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

    fn lifted(s: &St, reduce: bool) -> (f64, bool) {
        let ms = s.hover_at.elapsed().as_secs_f64() * 1000.0;
        (hover_progress(s.hover_from, s.hover, ms, reduce), reduce || ms >= HOVER_MS)
    }

    /// 지금 모습으로 다시 그린다 → 움직임(붙고 떼어짐 · 들림)이 다 끝났나
    fn present(id: u64) -> bool {
        let mut g = all();
        let Some(s) = g.get_mut(&id) else { return true };
        let reduce = reduce_motion();
        let size = (s.rect[2], s.rect[3]);
        let p = s.anim.map_or_else(|| pose(s.kind, None, f64::MAX, true, size), |(how, t0)| pose(s.kind, how, t0.elapsed().as_secs_f64() * 1000.0, reduce, size));
        let (hover, settled) = lifted(s, reduce);
        let [x, y, w, h] = physical(padded(s.rect), s.scale);
        let art_size = ((s.rect[2] * s.scale).round().max(1.0) as usize, (s.rect[3] * s.scale).round().max(1.0) as usize);
        if s.cache.as_ref().is_none_or(|(k, ..)| *k != art_size) {
            s.cache = Some((art_size, resize(art(s.kind, s.dark, false), art_size.0, art_size.1), resize(art(s.kind, s.dark, true), art_size.0, art_size.1)));
        }
        let (_, rest, up) = s.cache.as_ref().unwrap();
        // CSS 처럼 움직임(animation)이 도는 동안은 그 변환이 들림(transition)을 덮는다
        let transform = if s.anim.is_some() { p.transform } else { lift(s.kind, hover, size) };
        let img = render(rest, up, lift(s.kind, 1.0, size), hover, transform, size, s.scale, (w as usize, h as usize));
        let hwnd = s.hwnd as HWND;
        let alpha = p.opacity;
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
        if p.done {
            s.anim = None;
        }
        p.done && (settled || s.leaving) // 사라지는 중이면 들림이 덜 내려앉아도 끝
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
                let changed = all()
                    .get_mut(&id)
                    .filter(|s| !s.leaving && s.hover != over)
                    .map(|s| {
                        // 들리는 도중에 마우스가 나가도 그 자리에서 이어서 내려앉는다
                        s.hover_from = lifted(s, reduce_motion()).0;
                        s.hover_at = Instant::now();
                        s.hover = over;
                    })
                    .is_some();
                if changed {
                    if over {
                        let mut t = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: h, dwHoverTime: 0 };
                        unsafe { TrackMouseEvent(&mut t) };
                    }
                    present(id);
                    unsafe { SetTimer(h, TIMER, FRAME_MS, None) };
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
    fn css_curves_and_transforms() {
        // cubic-bezier: 끝점 · 대칭 곡선의 가운데
        assert!(bezier(SNAP, 0.0).abs() < 1e-6 && (bezier(SNAP, 1.0) - 1.0).abs() < 1e-6);
        assert!((bezier((0.25, 0.1, 0.75, 0.9), 0.5) - 0.5).abs() < 1e-4);
        assert!(bezier(SNAP, 0.3) > 0.8, "빨리 가다 부드럽게 멈춤");
        // rotate(90deg) 는 시계 방향 (화면 y 는 아래로): 원점 오른쪽 점이 아래로
        let r = css((0.0, 0.0), 0.0, 90.0, 1.0).apply((1.0, 0.0));
        assert!(r.0.abs() < 1e-9 && (r.1 - 1.0).abs() < 1e-9);
        // transform-origin 은 움직이지 않는다 · 되돌리면 제자리
        let m = css((10.0, 20.0), -12.0, -12.0, 1.16);
        let o = m.apply((10.0, 20.0));
        assert!((o.0 - 10.0).abs() < 1e-9 && (o.1 - 8.0).abs() < 1e-9);
        let back = m.inverse().apply(m.apply((3.0, 4.0)));
        assert!((back.0 - 3.0).abs() < 1e-9 && (back.1 - 4.0).abs() < 1e-9);
    }

    #[test]
    fn stick_peel_dock_poses() {
        let size = (64.0, 52.0);
        let start = pose("crown", None, 0.0, false, size);
        assert!(start.opacity.abs() < 1e-6 && !start.done);
        assert_ne!(start.transform, Affine::ID, "위에서 기울고 크게 시작");
        let end = pose("crown", None, 320.0, false, size);
        assert!((end.opacity - 1.0).abs() < 1e-6 && end.done);
        let c = end.transform.apply((5.0, 7.0));
        assert!((c.0 - 5.0).abs() < 1e-6 && (c.1 - 7.0).abs() < 1e-6, "끝나면 제자리");
        assert!(pose("tape", None, 0.0, true, size).done, "움직임을 줄이면 바로");
        let peel = pose("crown", Some(Leave::Peel), PEEL_MS, false, size);
        assert!(peel.opacity.abs() < 1e-6 && peel.done);
        assert!(peel.transform.apply((19.2, 41.6)).1 < 41.6 - 9.0, "위로 들리며");
        // 한 장면(16ms)마다 투명도가 10% 넘게 바뀌지 않는다 (붙기 · 떼기 · 들어가기)
        for leave in [None, Some(Leave::Peel), Some(Leave::Dock)] {
            let mut last = pose("crown", leave, 0.0, false, size).opacity;
            for f in 1..=40 {
                let now = pose("crown", leave, f as f64 * 16.0, false, size).opacity;
                assert!((now - last).abs() <= 0.1, "{leave:?} {f}: {last} → {now}");
                last = now;
            }
        }
        let dock = pose("crown", Some(Leave::Dock), 75.0, true, size);
        assert!((dock.opacity - 0.53).abs() < 0.01 && !dock.done && dock.transform == Affine::ID);
        // 들림: 반쯤에서 마우스가 나가면 그 자리에서 내려앉는다
        assert!((hover_progress(0.0, true, HOVER_MS, false) - 1.0).abs() < 1e-6);
        let mid = hover_progress(0.0, true, 50.0, false);
        assert!(mid > 0.0 && mid < 1.0);
        assert!((hover_progress(mid, false, 0.0, false) - mid).abs() < 1e-9);
        assert_eq!(physical([10.2, 20.0, 64.0, 52.0], 1.5), [15, 30, 96, 78]);
        assert_eq!(padded([100.0, 50.0, 64.0, 52.0]), [100.0 - PAD, 50.0 - PAD, 64.0 + 2.0 * PAD, 52.0 + 2.0 * PAD]);
    }

    #[test]
    fn render_places_art_inside_padding() {
        let size = (64.0, 52.0);
        let rest = resize(art("crown", false, false), 64, 52);
        let up = resize(art("crown", false, true), 64, 52);
        let (cw, ch) = ((64.0 + 2.0 * PAD) as usize, (52.0 + 2.0 * PAD) as usize);
        // 변환 없음 · 들림 없음: 둘레(PAD) 안쪽에 그림 그대로
        let still = render(&rest, &up, lift("crown", 1.0, size), 0.0, Affine::ID, size, 1.0, (cw, ch));
        let at = |img: &Image, x: usize, y: usize| img.px[(y * img.w + x) * 4 + 3];
        for (x, y) in [(32, 30), (10, 40), (50, 15)] {
            assert_eq!(at(&still, x + PAD as usize, y + PAD as usize), at(&rest, x, y));
        }
        assert_eq!(at(&still, 2, 2), 0, "둘레는 투명 (마우스가 통과)");
        // 다 들리면 들린 그림 그대로
        let lifted_full = render(&rest, &up, lift("crown", 1.0, size), 1.0, lift("crown", 1.0, size), size, 1.0, (cw, ch));
        for (x, y) in [(32, 30), (10, 40)] {
            assert!(at(&lifted_full, x + PAD as usize, y + PAD as usize).abs_diff(at(&up, x, y)) <= 2);
        }
        // 붙기 시작: 크고 기울어 둘레 밖으로도 번진다 (창을 넓힌 까닭)
        let big = render(&rest, &up, lift("crown", 1.0, size), 0.0, pose("crown", None, 0.0, false, size).transform, size, 1.0, (cw, ch));
        let rows_used = (0..ch).filter(|&y| (0..cw).any(|x| at(&big, x, y) > 0)).count();
        let rows_rest = (0..ch).filter(|&y| (0..cw).any(|x| at(&still, x, y) > 0)).count();
        assert!(rows_used > rows_rest);
    }
}
