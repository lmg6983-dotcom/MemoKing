# Popup notification watcher for MemoKing.
# Some apps (e.g. KakaoTalk PC) show their own small popup windows instead of Windows notifications,
# so those never reach the Action Center database. This helper watches for such popups and reads them:
#   1) UI Automation text of the popup window
#   2) if none, MSAA (IAccessible name / value / description) of the window and its children
#   3) if none, text of the child windows (WM_GETTEXT)
#   4) captures the window (PrintWindow) and reads it with the OCR built into Windows (Windows.Media.Ocr).
#      OCR always runs; text from 1)~3) is used only when it covers what OCR sees (some apps expose only junk names).
#      For OCR the capture is made opaque (layered/GDI windows leave alpha at 0 and OCR then sees an empty canvas)
#      the profile picture on the left is painted over (OCR reads it as stray letters glued to the sender name) and its top
#      is reported (lines above it are the chat room name), emoji are painted over (OCR reads them as symbols),
#      the image is turned gray with stretched contrast (dark popups inverted to dark-on-white),
#      and enlarged (small UI text reads much better), and each line keeps its place (x, y, w, h in 100%-scale px).
# One JSON line per new popup text on stdout:
#   {"process","pid","hwnd","windowTitle","lines":[...],"via":"uia|msaa|win32|ocr","image":"<png>","boxes":[{text,x,y,w,h}],"size":{w,h}}
# -Log <file>: one JSON line per popup with what each method found (to see how an app's popup can be read)
# Requires Windows PowerShell 5.1 (WinRT OCR):  powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File popup-watch.ps1 -Processes KakaoTalk -Dir <tmp>
param(
  [string]$Processes = 'KakaoTalk',   # process names without .exe, comma separated
  [int]$OnlyPid = 0,                  # self-test: watch only this process id (names ignored)
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$IntervalMs = 700,
  [switch]$ForceOcr,
  [string]$Log = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes, System.Runtime.WindowsRuntime
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class MkPopup {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public class Win { public long Hwnd; public uint Pid; public int X, Y, W, H; public string Title; public double Scale = 1; }

  // 화면 배율이 100% 가 아니어도 창 크기·그림을 실제 픽셀로 (배율을 모르는 프로세스는 줄어든 크기를 받아 그림이 잘린다)
  public static bool DpiAware;
  public static void Init() {
    try { DpiAware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // PER_MONITOR_AWARE_V2 (Windows 10 1703+)
    if (!DpiAware) { try { SetProcessDPIAware(); } catch { } }
    try { DpiAware = IsProcessDPIAware(); } catch { DpiAware = false; }
  }
  static double ScaleOf(IntPtr h) {
    if (!DpiAware) return 1;
    try { uint dpi = GetDpiForWindow(h); return dpi >= 96 ? dpi / 96.0 : 1; } catch { return 1; }
  }

  // 작은 맨 위(또는 도구) 창 = 알림 창 후보
  public static List<Win> Candidates(uint[] pids) {
    var list = new List<Win>();
    var set = new HashSet<uint>(pids);
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid) || !IsWindowVisible(h)) return true;
      long ex = GetWindowLongPtr(h, -20).ToInt64();
      bool topmost = (ex & 0x8) != 0, tool = (ex & 0x80) != 0;
      if (!topmost && !tool) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left, hh = r.Bottom - r.Top;
      double scale = ScaleOf(h);
      double lw = w / scale, lh = hh / scale; // 100% 배율 크기로 거른다
      if (lw < 120 || lw > 720 || lh < 40 || lh > 480) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
      list.Add(new Win { Hwnd = h.ToInt64(), Pid = pid, X = r.Left, Y = r.Top, W = w, H = hh, Title = sb.ToString(), Scale = scale });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // 창을 그림으로 (가려져 있어도). 바뀌었는지 볼 지문(작은 표본)도 함께
  public static Bitmap Capture(long hwnd, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(new IntPtr(hwnd), hdc, 2) || PrintWindow(new IntPtr(hwnd), hdc, 0); // PW_RENDERFULLCONTENT, 안 되면 기본
      g.ReleaseHdc(hdc);
      if (!ok) { bmp.Dispose(); return null; }
    }
    return bmp;
  }

  // 글자 인식용 그림: 알파를 무시해 불투명하게 (GDI 로 그린 글자는 알파가 0 이라 그대로면 빈 그림으로 보인다),
  // 왼쪽 프로필 사진은 바탕색으로 지우고 (글자 인식이 사진을 '렐' · '반' 같은 글자로 읽어 이름에 붙인다),
  // factor 배로 키운 뒤 흑백 · 대비를 늘린다 (작은 글자는 키우면 훨씬 잘 읽히고, 가는 획이 흐려지지 않게)
  // 마지막 OcrImage 에서 찾은 프로필 사진의 윗변 (원래 그림 px, 못 찾으면 -1) — 그 위 줄이 채팅방 이름
  public static int LastProfileTop = -1;
  public static Bitmap OcrImage(Bitmap src, double factor, double scale = 1) {
    LastProfileTop = -1;
    var opaque = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    var rect = new Rectangle(0, 0, src.Width, src.Height);
    var from = src.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var to = opaque.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try {
      int bytes = Math.Abs(from.Stride) * src.Height;
      var buf = new byte[bytes];
      Marshal.Copy(from.Scan0, buf, 0, bytes);
      for (int i = 3; i < bytes; i += 4) buf[i] = 255;
      int stride = Math.Abs(from.Stride), bin = BackgroundBin(buf, stride, src.Width, src.Height);
      var bgc = BackgroundColor(buf, stride, src.Width, src.Height, bin);
      int top = HideProfile(buf, stride, src.Width, src.Height, scale, bin, bgc);
      // 프로필 사진 윗변: 그보다 위의 작은 줄은 채팅방 이름 (메모킹이 보낸 사람과 같으면 1:1 대화로 보고 뺀다)
      if (top > 2 && top < src.Height * 0.6) LastProfileTop = top;
      HideEmoji(buf, stride, src.Width, src.Height, scale, bin, bgc);
      Marshal.Copy(buf, 0, to.Scan0, bytes);
    } finally { src.UnlockBits(from); opaque.UnlockBits(to); }
    Bitmap big = opaque;
    if (factor > 1.01) {
      int w = (int)Math.Round(src.Width * factor), h = (int)Math.Round(src.Height * factor);
      big = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(big)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
        using (var attrs = new ImageAttributes()) {
          attrs.SetWrapMode(System.Drawing.Drawing2D.WrapMode.TileFlipXY); // 가장자리 번짐 없이
          g.DrawImage(opaque, new Rectangle(0, 0, w, h), 0, 0, opaque.Width, opaque.Height, GraphicsUnit.Pixel, attrs);
        }
      }
      opaque.Dispose();
    }
    Enhance(big, 1.3);
    return big;
  }

  // 원래 크기 그대로 불투명하게만 (글자 다듬기에서 같은 글꼴로 그린 글과 견줄 그림)
  public static Bitmap Opaque(Bitmap src) {
    var opaque = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    var rect = new Rectangle(0, 0, src.Width, src.Height);
    var from = src.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var to = opaque.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    try {
      int bytes = Math.Abs(from.Stride) * src.Height;
      var buf = new byte[bytes];
      Marshal.Copy(from.Scan0, buf, 0, bytes);
      for (int i = 3; i < bytes; i += 4) buf[i] = 255;
      Marshal.Copy(buf, 0, to.Scan0, bytes);
    } finally { src.UnlockBits(from); opaque.UnlockBits(to); }
    return opaque;
  }

  static int Lum(byte[] buf, int o) { return (buf[o + 2] * 299 + buf[o + 1] * 587 + buf[o] * 114) / 1000; } // BGRA

  // 가장 많은 밝기 = 바탕 (4 단계씩 묶어서)
  static int BackgroundBin(byte[] buf, int stride, int w, int h) {
    var hist = new int[64];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) hist[Lum(buf, y * stride + x * 4) >> 2]++;
    int bin = 0;
    for (int v = 1; v < 64; v++) if (hist[v] > hist[bin]) bin = v;
    return bin;
  }

  // 바탕색 (가장 많은 밝기 칸의 평균 색, BGR)
  static byte[] BackgroundColor(byte[] buf, int stride, int w, int h, int bin) {
    long r = 0, g = 0, bl = 0, cnt = 0;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int o = y * stride + x * 4;
      if ((Lum(buf, o) >> 2) == bin) { bl += buf[o]; g += buf[o + 1]; r += buf[o + 2]; cnt++; }
    }
    if (cnt == 0) return new byte[] { 255, 255, 255 };
    return new byte[] { (byte)(bl / cnt), (byte)(g / cnt), (byte)(r / cnt) };
  }

  static void Paint(byte[] buf, int stride, int x0, int y0, int x1, int y1, byte[] c) {
    for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) {
      int o = y * stride + x * 4;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
    }
  }

  // 왼쪽 프로필 사진: 왼쪽 1/4 안에서 시작해 100% 배율로 16px 넘게 이어지는, 세로로 빽빽한(높이의 18% 넘게 바탕과 다른) 열들.
  // 글자는 그렇게 넓게 빽빽하지 않다. 찾으면 그 덩어리(옅은 가장자리까지)를 바탕색으로 칠하고, 사진의 윗변(행)을 돌려준다 (없으면 -1)
  static int HideProfile(byte[] buf, int stride, int w, int h, double scale, int bin, byte[] bgc) {
    if (w < 40 || h < 20) return -1;
    int bg = bin * 4 + 2;
    int lim = (int)(w * 0.35);
    var ink = new double[lim];
    for (int x = 0; x < lim; x++) {
      int n = 0;
      for (int y = 0; y < h; y++) if (Math.Abs(Lum(buf, y * stride + x * 4) - bg) > 40) n++;
      ink[x] = (double)n / h;
    }
    int need = Math.Max(8, (int)Math.Round(16 * scale)), start = -1;
    for (int x = 0, run = 0; x < lim; x++) {
      run = ink[x] > 0.18 ? run + 1 : 0;
      if (run >= need) { start = x - run + 1; break; }
    }
    if (start < 0 || start > w * 0.25) return -1;
    int end = start;
    while (end < lim - 1 && ink[end + 1] > 0.18) end++;
    // 사진의 윗변 · 아랫변: 빽빽한 열들 가운데 절반 넘게 칠해진 행이 4행 넘게 이어지는 곳 (1px 테두리 줄은 건너뛴다)
    int top = -1, bottom = -1;
    for (int y = 0, run = 0; y < h; y++) {
      int n = 0;
      for (int x = start; x <= end; x++) if (Math.Abs(Lum(buf, y * stride + x * 4) - bg) > 40) n++;
      run = n * 2 > end - start + 1 ? run + 1 : 0;
      if (run >= 4 && top < 0) top = y - 3;
      if (run >= 4) bottom = y;
    }
    if (top < 0) return -1;
    // 사진은 (둥글어도) 거의 정사각형: 높이만큼의 폭을 가운데 기준으로 지운다 — 옆의 글까지 번지지 않게
    int size = bottom - top + 1, mid = (start + end) / 2;
    int pad = Math.Max(2, (int)Math.Round(2 * scale));
    Paint(buf, stride, Math.Max(0, mid - size / 2 - pad), Math.Max(0, top - pad), Math.Min(w, mid + size / 2 + pad + 1), Math.Min(h, bottom + pad + 1), bgc);
    return top;
  }

  // 이모티콘: 글자 하나 크기(100% 배율 11~30px)의 거의 정사각형 덩어리 가운데
  //   (1) 테두리 얼굴: 안쪽에 큰 빈 곳(상자의 30% 넘게)이 있고 그 안에 작은 조각(눈 · 입)이 둘 넘게 있거나
  //   (2) 색칠한 그림: 상자의 55% 넘게 꽉 차고 색이 짙은 것 (글자는 회색 — 가장자리 색 번짐보다 훨씬 짙어야).
  //   한글은 받침 · 'ㅁ' 의 안쪽이 작고 안에 다른 조각을 품지 않는다. 찾으면 바탕색으로 지운다 (글자 인식이 기호로 읽지 않게)
  static int HideEmoji(byte[] buf, int stride, int w, int h, double scale, int bin, byte[] bgc) {
    int bg = bin * 4 + 2;
    var label = new int[w * h];
    var ink = new bool[w * h];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) ink[y * w + x] = Math.Abs(Lum(buf, y * stride + x * 4) - bg) > 40;
    var boxes = new List<long[]>(); // x0, y0, x1, y1, 칸 수, B · G · R 합
    var stack = new Stack<int>();
    for (int i = 0; i < ink.Length; i++) {
      if (!ink[i] || label[i] != 0) continue;
      int id = boxes.Count + 1, x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
      long sb = 0, sg = 0, sr = 0;
      label[i] = id; stack.Push(i);
      while (stack.Count > 0) {
        int p = stack.Pop(), px = p % w, py = p / w;
        n++;
        int o = py * stride + px * 4;
        sb += buf[o]; sg += buf[o + 1]; sr += buf[o + 2];
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
          int qx = px + dx, qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          int q = qy * w + qx;
          if (ink[q] && label[q] == 0) { label[q] = id; stack.Push(q); }
        }
      }
      boxes.Add(new long[] { x0, y0, x1, y1, n, sb, sg, sr });
    }
    double lo = 11 * scale, hi = 30 * scale;
    int hidden = 0;
    for (int k = 0; k < boxes.Count; k++) {
      var bx = boxes[k];
      int bw = (int)(bx[2] - bx[0] + 1), bh = (int)(bx[3] - bx[1] + 1);
      if (bw < lo || bh < lo || bw > hi || bh > hi) continue;
      double aspect = (double)bw / bh;
      if (aspect < 0.7 || aspect > 1.4) continue;
      // 평균 색의 짙기: 글자 가장자리의 ClearType 번짐은 양쪽이 빨강 · 파랑이라 평균하면 회색, 색 그림(노란 얼굴 등)은 그 색 그대로
      double mb = bx[5] / (double)bx[4], mg = bx[6] / (double)bx[4], mr = bx[7] / (double)bx[4];
      bool colored = bx[4] > bw * bh * 0.55 && Math.Max(mb, Math.Max(mg, mr)) - Math.Min(mb, Math.Min(mg, mr)) > 80;
      if (!colored && !IsFace(label, w, bx, k + 1, boxes)) continue;
      Paint(buf, stride, (int)Math.Max(0, bx[0] - 1), (int)Math.Max(0, bx[1] - 1), (int)Math.Min(w, bx[2] + 2), (int)Math.Min(h, bx[3] + 2), bgc);
      hidden++;
    }
    return hidden;
  }

  // 고리 안쪽(상자 가장자리에서 이 덩어리를 넘지 않고는 닿을 수 없는 곳)이 크고, 그 안에 다른 조각이 둘 넘게 있는가
  static bool IsFace(int[] label, int w, long[] bx, int id, List<long[]> boxes) {
    int x0 = (int)bx[0], y0 = (int)bx[1], bw = (int)(bx[2] - bx[0] + 1), bh = (int)(bx[3] - bx[1] + 1);
    var outside = new bool[bw * bh];
    var stack = new Stack<int>();
    for (int y = 0; y < bh; y++) for (int x = 0; x < bw; x++) {
      if (x != 0 && y != 0 && x != bw - 1 && y != bh - 1) continue;
      int i = y * bw + x;
      if (label[(y + y0) * w + x + x0] != id && !outside[i]) { outside[i] = true; stack.Push(i); }
    }
    while (stack.Count > 0) {
      int p = stack.Pop(), px = p % bw, py = p / bw;
      for (int d = 0; d < 4; d++) {
        int qx = px + (d == 0 ? 1 : d == 1 ? -1 : 0), qy = py + (d == 2 ? 1 : d == 3 ? -1 : 0);
        if (qx < 0 || qy < 0 || qx >= bw || qy >= bh) continue;
        int q = qy * bw + qx;
        if (!outside[q] && label[(qy + y0) * w + qx + x0] != id) { outside[q] = true; stack.Push(q); }
      }
    }
    if (bx[4] > bw * bh * 0.55) return false; // 고리는 가늘다
    // 안쪽 빈 곳: 넓고(상자의 30% 넘게) 상자의 가로 · 세로 대부분(60%)에 걸친다 (글자 안의 좁은 틈과 다르게)
    int hole = 0, hx0 = bw, hy0 = bh, hx1 = -1, hy1 = -1;
    for (int y = 0; y < bh; y++) for (int x = 0; x < bw; x++) {
      if (outside[y * bw + x] || label[(y + y0) * w + x + x0] == id) continue;
      hole++;
      if (x < hx0) hx0 = x; if (x > hx1) hx1 = x; if (y < hy0) hy0 = y; if (y > hy1) hy1 = y;
    }
    if (hole < bw * bh * 0.3 || hx1 - hx0 + 1 < bw * 0.6 || hy1 - hy0 + 1 < bh * 0.6) return false;
    // 그 안의 작은 조각(눈 · 입): 둘 넘게, 하나하나가 상자의 35% 를 넘지 않는다
    int inner = 0;
    for (int k = 0; k < boxes.Count && inner < 2; k++) {
      var o = boxes[k];
      if (k + 1 == id) continue;
      int cx = (int)((o[0] + o[2]) / 2) - x0, cy = (int)((o[1] + o[3]) / 2) - y0;
      if (cx <= 0 || cy <= 0 || cx >= bw - 1 || cy >= bh - 1) continue;
      if (o[2] - o[0] + 1 > bw * 0.35 && o[3] - o[1] + 1 > bh * 0.35) continue;
      if (o[2] - o[0] + 1 > bw * 0.6 || o[3] - o[1] + 1 > bh * 0.6) continue;
      if (!outside[cy * bw + cx]) inner++;
    }
    return inner >= 2;
  }

  // 흑백 · 대비 늘리기: 바탕은 흰색, 가장 진한 글자는 검정으로 펴고 감마로 가는 획을 진하게.
  // 어두운 바탕(다크 모드 알림)은 뒤집어 흰 바탕에 검은 글자로 (글자 인식이 가장 잘 읽는 모양)
  static void Enhance(Bitmap bmp, double gamma) {
    var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
    try {
      int stride = Math.Abs(data.Stride), w = bmp.Width, h = bmp.Height, bytes = stride * h;
      var buf = new byte[bytes];
      Marshal.Copy(data.Scan0, buf, 0, bytes);
      bool inv = BackgroundBin(buf, stride, w, h) * 4 + 2 < 128;
      var hist = new int[256];
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int v = Lum(buf, y * stride + x * 4);
        hist[inv ? 255 - v : v]++;
      }
      int bgv = 0;
      for (int v = 1; v < 256; v++) if (hist[v] > hist[bgv]) bgv = v;
      long acc = 0, total = (long)w * h; int lo = 0;
      for (int v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.005) { lo = v; break; } }
      double span = Math.Max(16, bgv - lo);
      var lut = new byte[256];
      for (int v = 0; v < 256; v++) {
        double t = Math.Min(1, Math.Max(0, ((inv ? 255 - v : v) - lo) / span));
        lut[v] = (byte)Math.Round(255 * Math.Pow(t, gamma));
      }
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int o = y * stride + x * 4;
        byte g = lut[Lum(buf, o)];
        buf[o] = g; buf[o + 1] = g; buf[o + 2] = g; buf[o + 3] = 255;
      }
      Marshal.Copy(buf, 0, data.Scan0, bytes);
    } finally { bmp.UnlockBits(data); }
  }
  // 아직 그려지지 않은 창(나타나는 중의 검은 · 한 색 그림)인가 — 글자가 하나도 없는 한 색이면 읽지 않고 다음 차례에
  public static bool IsBlank(Bitmap b) {
    int lo = int.MaxValue, hi = int.MinValue;
    for (int y = 1; y < b.Height; y += Math.Max(1, b.Height / 24))
      for (int x = 1; x < b.Width; x += Math.Max(1, b.Width / 32)) {
        Color c = b.GetPixel(x, y);
        int v = c.R + c.G + c.B;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    return hi - lo < 30;
  }
  public static string Fingerprint(Bitmap b) {
    long sum = 0; int n = 0;
    for (int y = 2; y < b.Height; y += Math.Max(1, b.Height / 16))
      for (int x = 2; x < b.Width; x += Math.Max(1, b.Width / 24)) { sum = sum * 31 + b.GetPixel(x, y).ToArgb(); n++; }
    return n + ":" + sum.ToString();
  }
}
'@

[MkPopup]::Init()

# ---------- 글자 그대로 읽기: MSAA(접근성) · 자식 창 글자 ----------
Add-Type -AssemblyName Accessibility
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;

public static class MkText {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object obj);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible acc, int start, int count, [Out] object[] children, out int obtained);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);

  static void Add(List<string> list, Func<string> f) {
    try { var s = f(); if (!string.IsNullOrWhiteSpace(s)) list.Add(s.Trim()); } catch { }
  }

  // 창(과 그 안)의 접근성 이름·값·설명
  public static string[] Msaa(long hwnd) {
    var list = new List<string>();
    try {
      Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); // IID_IAccessible
      object o;
      if (AccessibleObjectFromWindow(new IntPtr(hwnd), 0xFFFFFFFC, ref iid, out o) == 0 && o is IAccessible) Walk((IAccessible)o, list, 0); // OBJID_CLIENT
    } catch { }
    return list.ToArray();
  }

  static void Walk(IAccessible acc, List<string> list, int depth) {
    if (depth > 6 || list.Count > 120) return;
    Add(list, () => acc.get_accName(0));
    Add(list, () => acc.get_accValue(0));
    Add(list, () => acc.get_accDescription(0));
    int n = 0;
    try { n = acc.accChildCount; } catch { }
    if (n <= 0) return;
    n = Math.Min(n, 80);
    var kids = new object[n];
    int got;
    try { if (AccessibleChildren(acc, 0, n, kids, out got) != 0) return; } catch { return; }
    for (int i = 0; i < got; i++) {
      var child = kids[i] as IAccessible;
      if (child != null) { Walk(child, list, depth + 1); continue; }
      if (kids[i] is int) {
        object id = kids[i];
        Add(list, () => acc.get_accName(id));
        Add(list, () => acc.get_accValue(id));
      }
    }
  }

  // 자식 창들의 글자 (WM_GETTEXT, 응답 없으면 건너뜀)
  public static string[] Win32(long hwnd) {
    var list = new List<string>();
    EnumChildWindows(new IntPtr(hwnd), (h, l) => {
      var sb = new StringBuilder(2048);
      IntPtr r;
      if (SendMessageTimeout(h, 0x000D, new IntPtr(sb.Capacity), sb, 0x0002, 200, out r) != IntPtr.Zero && sb.Length > 0) list.Add(sb.ToString().Trim());
      return list.Count < 80;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  // 진단용: 창과 자식 창들의 종류(class)
  public static string[] Classes(long hwnd) {
    var list = new List<string>();
    var sb = new StringBuilder(256);
    GetClassName(new IntPtr(hwnd), sb, 256);
    list.Add(sb.ToString());
    EnumChildWindows(new IntPtr(hwnd), (h, l) => {
      var c = new StringBuilder(256);
      GetClassName(h, c, 256);
      list.Add(c.ToString());
      return list.Count < 40;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@

# 읽은 조각들 정리: 공백 하나로, 같은 것은 한 번, 창 제목과 같은 것은 빼고, 다른 조각들을 통째로 담은 덩어리도 뺀다
function Select-Fragments([string[]]$items, [string]$title) {
  $seen = @{}
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($raw in $items) {
    $name = ($raw -replace '\s+', ' ').Trim()
    if (-not $name -or $name -eq $title -or $seen.ContainsKey($name)) { continue }
    $seen[$name] = $true
    $out.Add($name)
  }
  @($out | Where-Object { $n = $_; -not ($out | Where-Object { $_ -ne $n -and $n.Contains($_) -and $_.Length -ge 2 }) })
}

function Write-PopupLog($entry) {
  if (-not $Log) { return }
  try {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 300KB) { Clear-Content $Log }
    [IO.File]::AppendAllText($Log, (($entry | ConvertTo-Json -Compress -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding $false))
  } catch { }
}

# ---------- WinRT 글자 인식 (한국어) ----------
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
if (-not $ocr) { $ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
# 한국어 글자 인식이 없으면(Windows 언어 설정 > 한국어 > 광학 문자 인식) 한글을 못 읽는다 — 기록에 남겨 둔다
Write-PopupLog ([ordered]@{ time = (Get-Date).ToString('o'); ocrLanguage = $(if ($ocr) { $ocr.RecognizerLanguage.LanguageTag } else { '' }); dpiAware = [MkPopup]::DpiAware })

# 그림 파일 글자 인식 → 줄마다 { text, x, y, w, h } (unit = 그림 px 가 100% 배율 화면 px 의 몇 배인지)
function Read-Ocr([string]$png, [double]$unit = 1) {
  if (-not $ocr) { return @() }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    foreach ($line in $result.Lines) {
      # 한글 OCR 은 글자마다 띄어 주므로 단어 사이 간격으로 다시 붙인다
      $text = ''
      $prev = $null
      $x0 = [double]::MaxValue; $y0 = [double]::MaxValue; $x1 = 0.0; $y1 = 0.0
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        if ($prev) {
          $gap = $r.X - ($prev.X + $prev.Width)
          if ($gap -gt ($prev.Height * 0.35)) { $text += ' ' }
        }
        $text += $w.Text
        $prev = $r
        $x0 = [Math]::Min($x0, $r.X); $y0 = [Math]::Min($y0, $r.Y)
        $x1 = [Math]::Max($x1, $r.X + $r.Width); $y1 = [Math]::Max($y1, $r.Y + $r.Height)
      }
      $text = $text.Trim()
      if ($text) {
        [ordered]@{ text = $text; x = [Math]::Round($x0 / $unit, 1); y = [Math]::Round($y0 / $unit, 1); w = [Math]::Round(($x1 - $x0) / $unit, 1); h = [Math]::Round(($y1 - $y0) / $unit, 1) }
      }
    }
  } finally { $stream.Dispose() }
}

# 바로 읽은 글이 화면의 글(글자 인식 결과)을 얼마나 담고 있는지 (0~1). 공백·기호는 빼고 글자끼리 견준다.
# 앱에 따라 UI 자동화·접근성으로는 "Pane" 같은 엉뚱한 이름만 나오므로, 글자 수가 아니라 같은 글자인지를 본다.
function Get-Letters([string[]]$lines, [string]$title) {
  @($lines | Where-Object { $_ -and $_.Trim() -ne $title } | ForEach-Object { ($_ -replace '[^\p{L}\p{N}]', '').ToCharArray() })
}
function Measure-Cover([string[]]$direct, [string[]]$ocrLines, [string]$title) {
  $want = Get-Letters $ocrLines $title
  if ($want.Count -lt 2) { return $(if ((Get-Letters $direct $title).Count -ge 2) { 1.0 } else { 0.0 }) }   # 화면에서 글을 못 읽었으면 바로 읽은 글을 믿는다
  $have = @{}
  foreach ($c in (Get-Letters $direct $title)) { $k = [string]$c; $have[$k] = 1 + [int]$have[$k] }
  $hit = 0
  foreach ($c in $want) { $k = [string]$c; if ([int]$have[$k] -gt 0) { $have[$k]--; $hit++ } }
  $hit / $want.Count
}

function Read-Uia([long]$hwnd, [string]$title) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($el in $all) {
      if ($out.Count -ge 40) { break }
      $name = ($el.Current.Name -replace '\s+', ' ').Trim()
      if (-not $name -or $name -eq $title -or $seen.ContainsKey($name)) { continue }
      $type = $el.Current.ControlType.ProgrammaticName
      if ($type -match 'Button|ScrollBar|TitleBar|MenuBar|Image') { continue }
      $seen[$name] = $true
      $out.Add($name)
    }
    # 문서·창 이름처럼 다른 글을 다 담은 덩어리는 빼고 가장 작은 조각들만
    @($out | Where-Object { $n = $_; -not ($out | Where-Object { $_ -ne $n -and $n.Contains($_) -and $_.Length -ge 2 }) })
  } catch { @() }
}

$names = @($Processes -split ',' | ForEach-Object { $_.Trim() -replace '\.exe$', '' } | Where-Object { $_ })
$state = @{}       # hwnd -> @{ fp; stable; sent }
while ($true) {
  try {
    if ($OnlyPid -gt 0) { $pids = @([uint32]$OnlyPid) }
    else { $pids = @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id }) }
    $alive = @{}
    if ($pids.Count) {
      foreach ($w in [MkPopup]::Candidates($pids)) {
        $alive[$w.Hwnd] = $true
        $bmp = [MkPopup]::Capture($w.Hwnd, $w.W, $w.H)
        if (-not $bmp) { continue }
        try {
          $s = $state[$w.Hwnd]
          if (-not $s) { $s = @{ fp = ''; stable = 0; sent = '' }; $state[$w.Hwnd] = $s }
          if ([MkPopup]::IsBlank($bmp)) { $s.fp = ''; $s.stable = 0; continue }   # 나타나는 중(검은 그림) → 그려진 뒤에
          $fp = [MkPopup]::Fingerprint($bmp)
          if ($s.fp -ne $fp) { $s.fp = $fp; $s.stable = 0; continue }   # 그려지는 중 → 다음 차례에
          $s.stable++
          if ($s.stable -ne 1) { continue }                                # 모양이 그대로면 한 번만 읽는다
          $png = Join-Path $Dir ("popup-{0}-{1}.png" -f $w.Hwnd, [DateTime]::Now.Ticks)
          $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
          # 1) 글자를 그대로 읽을 수 있는 방법: UI 자동화 → 접근성(MSAA) → 자식 창 글자
          $found = [ordered]@{ uia = @(); msaa = @(); win32 = @() }
          $direct = @(); $directVia = ''
          if (-not $ForceOcr) {
            $found.uia = @(Read-Uia $w.Hwnd $w.Title)
            if ($found.uia.Count) { $directVia = 'uia'; $direct = $found.uia }
            $found.msaa = @(Select-Fragments ([MkText]::Msaa($w.Hwnd)) $w.Title)
            if (-not $direct.Count -and $found.msaa.Count) { $directVia = 'msaa'; $direct = $found.msaa }
            $found.win32 = @(Select-Fragments ([MkText]::Win32($w.Hwnd)) $w.Title)
            if (-not $direct.Count -and $found.win32.Count) { $directVia = 'win32'; $direct = $found.win32 }
          }
          # 2) 글자 인식용으로 알림 창 그림을 불투명하게·100% 기준 3배로 키워 따로 저장한다 (최대 변 2200px 까지).
          #    이 그림은 메모킹(Node)이 한글에 강한 tesseract.js 로 다시 읽는 데 쓴다. Windows 기본 OCR 은 보조로만.
          $boxes = @()
          $ocrPng = ''
          $verifyPng = ''
          $ocrUnit = 1.0
          $factor = [Math]::Max(1.0, [Math]::Min(3.0 / $w.Scale, 2200.0 / [Math]::Max($w.W, $w.H)))
          try {
            $big = [MkPopup]::OcrImage($bmp, $factor, $w.Scale)
            $ocrPng = "$png.ocr.png"
            $big.Save($ocrPng, [System.Drawing.Imaging.ImageFormat]::Png)
            $ocrUnit = $factor * $w.Scale
            $big.Dispose()
            $verifyPng = "$png.raw.png"
            $raw = [MkPopup]::Opaque($bmp)
            $raw.Save($verifyPng, [System.Drawing.Imaging.ImageFormat]::Png)
            $raw.Dispose()
            if ($ocr) {
              $capped = [Math]::Min($factor, ([Windows.Media.Ocr.OcrEngine]::MaxImageDimension - 1) / [Math]::Max($w.W, $w.H))
              if ([Math]::Abs($capped - $factor) -lt 0.01) { $boxes = @(Read-Ocr $ocrPng $ocrUnit) }
            }
          } catch { Write-PopupLog ([ordered]@{ time = (Get-Date).ToString('o'); ocrError = $_.Exception.Message }) }
          $ocrLines = @($boxes | ForEach-Object { $_.text })
          # 바로 읽은 글이 화면의 글(글자 인식)을 거의 다 담고 있으면 그것을 (틀린 글자가 없다), 아니면 글자 인식 결과를
          $cover = Measure-Cover $direct $ocrLines $w.Title
          if ($direct.Count -and $cover -ge 0.6) { $via = $directVia; $lines = $direct }
          else { $via = 'ocr'; $lines = $ocrLines }
          $size = [ordered]@{ w = [Math]::Round($w.W / $w.Scale); h = [Math]::Round($w.H / $w.Scale) }
          Write-PopupLog ([ordered]@{ time = (Get-Date).ToString('o'); classes = @([MkText]::Classes($w.Hwnd)); title = $w.Title; size = "$($size.w)x$($size.h)"; scale = $w.Scale; uia = $found.uia; msaa = $found.msaa; win32 = $found.win32; ocr = $boxes; cover = [Math]::Round($cover, 2); via = $via; lines = $lines })
          $key = ($lines -join "`n")
          # via 가 'ocr' 이면 Node 가 ocrImage 를 한글 OCR 로 다시 읽으므로, 바로 읽은 글만으로 중복 판단하지 않는다
          $dedupeKey = $(if ($via -eq 'ocr') { "ocr:$($w.Hwnd):$fp" } else { $key })
          if ((-not $key -and $via -ne 'ocr') -or $dedupeKey -eq $s.sent) { @($png, $ocrPng, $verifyPng) | Where-Object { $_ } | Remove-Item -ErrorAction SilentlyContinue; continue }
          $s.sent = $dedupeKey
          $proc = (Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).ProcessName
          $msg = [ordered]@{ process = $proc; pid = $w.Pid; hwnd = $w.Hwnd; windowTitle = $w.Title; lines = @($lines); via = $via; image = $png; size = $size }
          if ($via -eq 'ocr') { $msg['boxes'] = @($boxes); $msg['ocrImage'] = $ocrPng; $msg['ocrUnit'] = [Math]::Round($ocrUnit, 4); $msg['verifyImage'] = $verifyPng; $msg['scale'] = $w.Scale; $msg['profileTop'] = $(if ([MkPopup]::LastProfileTop -gt 0) { [Math]::Round([MkPopup]::LastProfileTop / $w.Scale, 1) } else { 0 }) }
          else { @($ocrPng, $verifyPng) | Where-Object { $_ } | Remove-Item -ErrorAction SilentlyContinue }
          [Console]::Out.WriteLine(($msg | ConvertTo-Json -Compress -Depth 4))
          [Console]::Out.Flush()
        } finally { $bmp.Dispose() }
      }
    }
    foreach ($h in @($state.Keys)) { if (-not $alive.ContainsKey($h)) { $state.Remove($h) } }   # 닫히면 잊는다 (다시 뜨면 새로 읽음)
  } catch {
    [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  Start-Sleep -Milliseconds $IntervalMs
}
