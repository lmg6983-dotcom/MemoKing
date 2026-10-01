# Windows clipboard helper for MemoKing.
#   - Quick memo hotkey (Ctrl+Alt+C): capture / serve  -> copies the selection in the foreground app and dumps the clipboard
#   - Area capture (Ctrl+Alt+C twice): serve 'selrect' -> screen rectangle of the drag-selected content (UI Automation)
#   - Clipboard smoke test (npm run smoke:clipboard): text / html / image / files / backup / restore
# Puts the same formats real apps put on the clipboard:
#   text  - Notepad          (Unicode text)
#   html  - browser / Word   (CF_HTML "HTML Format" + text, optionally an image)
#   image - screenshot tool  (bitmap)
#   files - File Explorer    (file drop list, CF_HDROP)
# backup / restore keep the user's clipboard intact around the test.
# Requires STA:  powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File clipboard-helper.ps1 -Action ...
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('backup', 'restore', 'text', 'html', 'image', 'files', 'capture', 'serve')]
  [string]$Action,
  [string]$Dir,
  [string]$TextFile,
  [string]$HtmlFile,
  [string]$ImageFile,
  [string]$ListFile,
  [switch]$NoCopy
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$utf8 = New-Object System.Text.UTF8Encoding $false

# CF_HTML needs a byte-offset header; offsets are in UTF-8 bytes.
function ConvertTo-CfHtml([string]$fragment) {
  $pre = '<html><body><!--StartFragment-->'
  $post = '<!--EndFragment--></body></html>'
  $template = "Version:0.9`r`nStartHTML:{0:D10}`r`nEndHTML:{1:D10}`r`nStartFragment:{2:D10}`r`nEndFragment:{3:D10}`r`n"
  $headerLength = $utf8.GetByteCount(($template -f 0, 0, 0, 0))
  $startFragment = $headerLength + $utf8.GetByteCount($pre)
  $endFragment = $startFragment + $utf8.GetByteCount($fragment)
  $endHtml = $endFragment + $utf8.GetByteCount($post)
  $text = ($template -f $headerLength, $endHtml, $startFragment, $endFragment) + $pre + $fragment + $post
  return , $utf8.GetBytes($text)
}

function Set-ClipboardData([System.Windows.Forms.DataObject]$data) {
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
}

function New-Data { New-Object System.Windows.Forms.DataObject }

# 클립보드 내용을 폴더에 풀어 둔다: files.txt · text.txt · html.bin(CF_HTML 그대로) · image.png · manifest.json
# 다른 앱이 클립보드를 잠깐 잡고 있으면 실패할 수 있어 몇 번 다시 시도한다.
function Save-Clipboard([string]$dir) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  for ($try = 1; ; $try++) {
    try {
      $manifest = @{ files = $false; text = $false; html = $false; image = $false }
      if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
        [IO.File]::WriteAllLines((Join-Path $dir 'files.txt'), [string[]]@($files), $utf8)
        $manifest.files = $true
      }
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        [IO.File]::WriteAllText((Join-Path $dir 'text.txt'), [System.Windows.Forms.Clipboard]::GetText(), $utf8)
        $manifest.text = $true
      }
      if ([System.Windows.Forms.Clipboard]::ContainsData('HTML Format')) {
        # .NET 의 GetData('HTML Format') 는 UTF-8 을 다른 인코딩으로 풀어 한글이 깨진다 → Win32 로 원본 바이트를 읽는다
        Initialize-WinApi
        $bytes = [MkWin]::HtmlBytes()
        if ($null -ne $bytes) {
          [IO.File]::WriteAllBytes((Join-Path $dir 'html.bin'), $bytes)
          $manifest.html = $true
        }
      }
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        [System.Windows.Forms.Clipboard]::GetImage().Save((Join-Path $dir 'image.png'), [System.Drawing.Imaging.ImageFormat]::Png)
        $manifest.image = $true
      }
      ($manifest | ConvertTo-Json -Compress) | Set-Content -Encoding ASCII (Join-Path $dir 'manifest.json')
      return $manifest
    } catch {
      if ($try -ge 5) { throw }
      Start-Sleep -Milliseconds 60
    }
  }
}

# ---------- 빠른 메모 (Ctrl+Alt+C) ----------
# 앞에 있는 창의 선택 영역을 Ctrl+C 로 복사하게 한 뒤, 클립보드를 풀어 둔다.
$script:winApiLoaded = $false
function Initialize-WinApi {
  if ($script:winApiLoaded) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MkWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);
  // 클립보드의 "HTML Format"(CF_HTML, UTF-8) 원본 바이트
  public static byte[] HtmlBytes() {
    uint format = RegisterClipboardFormat("HTML Format");
    bool open = false;
    for (int i = 0; i < 10 && !open; i++) { open = OpenClipboard(IntPtr.Zero); if (!open) System.Threading.Thread.Sleep(30); }
    if (!open) return null;
    try {
      IntPtr h = GetClipboardData(format);
      if (h == IntPtr.Zero) return null;
      IntPtr ptr = GlobalLock(h);
      if (ptr == IntPtr.Zero) return null;
      try {
        int size = (int)GlobalSize(h);
        byte[] data = new byte[size];
        Marshal.Copy(ptr, data, 0, size);
        int end = Array.IndexOf(data, (byte)0);
        if (end >= 0) Array.Resize(ref data, end);
        return data;
      } finally { GlobalUnlock(h); }
    } finally { CloseClipboard(); }
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  // 사용자가 누르고 있는 Ctrl·Alt·Shift·C·Win 키
  public static bool KeysDown() {
    int[] keys = { 0x11, 0x12, 0x10, 0x43, 0x5B, 0x5C };
    foreach (int k in keys) if ((GetAsyncKeyState(k) & 0x8000) != 0) return true;
    return false;
  }
  public static void CtrlC() {
    keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(0x43, 0, 0, UIntPtr.Zero);
    keybd_event(0x43, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
'@
  $script:winApiLoaded = $true
}

# 앞 창에서 드래그로 선택한 내용(글·글 속 그림)의 화면 사각형 — UI 자동화 TextPattern 의 선택 범위
# 좌표는 실제 화면 픽셀 (스레드를 모니터별 DPI 인식으로 두고 읽는다). 응답 없는 앱에 묶이지 않게 시간 제한.
function Initialize-SelApi {
  if ($script:selApiLoaded) { return }
  # UI 자동화·WindowsBase 는 .NET 기본 폴더가 아니라 WPF 폴더에 있어 이름만으로는 컴파일러가 찾지 못한다 → 불러온 뒤 실제 파일 경로로
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
  $refs = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.AutomationElementIdentifiers].Assembly.Location,
    [System.Windows.Rect].Assembly.Location
  )
  Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public static class MkSel {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  // 선택 위치 (+ 화면 밖까지 이어지는지, 보이는 영역)
  public class Result { public bool Found, More; public double X, Y, W, H, VX, VY, VW, VH; public uint Pid; public long Hwnd; public string Error; }
  // 스크롤 한 번의 결과: 보이는 영역, 그 안의 선택 부분, 스크롤한 거리, 선택 끝이 보이는지
  public class Step { public bool Ok, AtEnd, HasSel; public double Moved, SX, SY, SW, SH, VX, VY, VW, VH; public string Error; }

  // 스크롤 캡처 동안 기억해 두는 것 (selrect 가 정하고 selscroll 이 쓴다)
  static TextPattern sPat; static TextPatternRange sSel; static AutomationElement sEl; static IntPtr sHwnd;
  static ScrollPattern sScroll; static double sH = -1, sV = -1;

  // 응답 없는 앱에 묶이지 않게 시간 제한 + 모니터별 DPI 인식 스레드에서 (좌표 = 실제 화면 픽셀)
  static T Run<T>(Func<T> f, int timeoutMs, Func<string, T> fail) {
    var task = Task.Run(() => {
      IntPtr old = IntPtr.Zero;
      try { old = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // PER_MONITOR_AWARE_V2 (Windows 10 1607+)
      try { return f(); }
      finally { if (old != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(old); } catch { } } }
    });
    try {
      if (!task.Wait(timeoutMs)) return fail("timeout");
      return task.Result;
    } catch (AggregateException e) {
      return fail(e.InnerException != null ? e.InnerException.Message : e.Message);
    }
  }

  class Box {
    public double L = double.MaxValue, T = double.MaxValue, R = double.MinValue, B = double.MinValue;
    public bool Any;
    public void Add(System.Windows.Rect rc) {
      if (rc.IsEmpty || double.IsInfinity(rc.X) || double.IsNaN(rc.X) || rc.Width < 1 || rc.Height < 1) return;
      L = Math.Min(L, rc.Left); T = Math.Min(T, rc.Top); R = Math.Max(R, rc.Right); B = Math.Max(B, rc.Bottom); Any = true;
    }
    public void Clip(double l, double t, double r, double b) { L = Math.Max(L, l); T = Math.Max(T, t); R = Math.Min(R, r); B = Math.Min(B, b); }
    public bool Valid { get { return Any && R - L >= 4 && B - T >= 4; } }
  }

  static void AddRange(Box box, TextPatternRange range) {
    foreach (var rc in range.GetBoundingRectangles()) box.Add(rc);
    try { foreach (var k in range.GetChildren()) { if (!k.Current.IsOffscreen) box.Add(k.Current.BoundingRectangle); } } catch { }
  }

  // 보이는 영역 = 글이 있는 요소의 사각형 ∩ 창
  static Box ViewBox() {
    var v = new Box();
    v.Add(sEl.Current.BoundingRectangle);
    RECT wr;
    if (GetWindowRect(sHwnd, out wr)) v.Clip(wr.Left, wr.Top, wr.Right, wr.Bottom);
    return v;
  }

  public static Result Find(int timeoutMs) { return Run(() => FindNow(), timeoutMs, e => new Result { Error = e }); }

  static Result FindNow() {
    sPat = null; sSel = null; sEl = null; sScroll = null; sH = sV = -1;
    IntPtr fg = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(fg, out pid);
    var res = new Result { Pid = pid, Hwnd = fg.ToInt64() };
    var el = AutomationElement.FocusedElement;
    if (el == null || el.Current.ProcessId != (int)pid) return res;
    var box = new Box();
    var walker = TreeWalker.RawViewWalker;
    // 포커스가 문서 안의 작은 요소일 수 있어 TextPattern 이 있는 조상까지 올라가며 찾는다
    for (int depth = 0; el != null && depth < 12 && !box.Any; depth++) {
      object pat;
      if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat)) {
        var tp = (TextPattern)pat;
        TextPatternRange first = null, last = null;
        foreach (TextPatternRange range in tp.GetSelection()) {
          string text = range.GetText(256) ?? "";
          AutomationElement[] kids = new AutomationElement[0];
          try { kids = range.GetChildren(); } catch { }
          if (text.Trim().Length == 0 && kids.Length == 0) continue; // 커서만 있음
          AddRange(box, range);
          if (first == null) first = range;
          last = range;
        }
        if (first != null) {
          sPat = tp; sEl = el; sHwnd = fg;
          sSel = first.Clone();
          if (last != first) sSel.MoveEndpointByRange(TextPatternRangeEndpoint.End, last, TextPatternRangeEndpoint.End);
          // 선택이 보이는 곳 밖(위·아래)까지 이어지는지
          try {
            var vis = tp.GetVisibleRanges();
            if (vis.Length > 0) {
              res.More = sSel.CompareEndpoints(TextPatternRangeEndpoint.Start, vis[0], TextPatternRangeEndpoint.Start) < 0
                || sSel.CompareEndpoints(TextPatternRangeEndpoint.End, vis[vis.Length - 1], TextPatternRangeEndpoint.End) > 0;
            }
          } catch { }
        }
      }
      if (!box.Any) el = walker.GetParent(el);
    }
    if (!box.Any) return res;
    RECT wr;
    if (GetWindowRect(fg, out wr)) box.Clip(wr.Left, wr.Top, wr.Right, wr.Bottom);
    if (!box.Valid && !res.More) return res;
    var view = ViewBox();
    if (view.Valid) { res.VX = view.L; res.VY = view.T; res.VW = view.R - view.L; res.VH = view.B - view.T; }
    else res.More = false;
    if (box.Valid) { res.X = box.L; res.Y = box.T; res.W = box.R - box.L; res.H = box.B - box.T; }
    res.Found = box.Valid || res.More;
    if (res.More) {
      // 끝나면 원래 스크롤 위치로 되돌리려고 기억해 둔다
      for (var s = sEl; s != null && sScroll == null; s = walker.GetParent(s)) {
        object sp;
        if (s.TryGetCurrentPattern(ScrollPattern.Pattern, out sp) && ((ScrollPattern)sp).Current.VerticallyScrollable) sScroll = (ScrollPattern)sp;
      }
      if (sScroll != null) { sH = sScroll.Current.HorizontalScrollPercent; sV = sScroll.Current.VerticalScrollPercent; }
    }
    return res;
  }

  static double Top(TextPatternRange r) {
    var rects = r.GetBoundingRectangles();
    return rects.Length > 0 ? rects[0].Top : double.NaN;
  }

  static Step Snap(double moved) {
    var st = new Step { Ok = true, Moved = moved };
    var view = ViewBox();
    if (!view.Valid) return new Step { Error = "no view" };
    st.VX = view.L; st.VY = view.T; st.VW = view.R - view.L; st.VH = view.B - view.T;
    var box = new Box();
    AddRange(box, sSel);
    box.Clip(view.L, view.T, view.R, view.B);
    if (box.Valid) { st.HasSel = true; st.SX = box.L; st.SY = box.T; st.SW = box.R - box.L; st.SH = box.B - box.T; }
    var vis = sPat.GetVisibleRanges();
    st.AtEnd = vis.Length == 0 || sSel.CompareEndpoints(TextPatternRangeEndpoint.End, vis[vis.Length - 1], TextPatternRangeEndpoint.End) <= 0;
    return st;
  }

  // 선택 첫 줄을 보이는 곳 맨 위로
  public static Step Start(int timeoutMs) {
    return Run(() => {
      if (sSel == null) return new Step { Error = "no selection" };
      var r = sSel.Clone();
      r.MoveEndpointByRange(TextPatternRangeEndpoint.End, r, TextPatternRangeEndpoint.Start);
      r.ExpandToEnclosingUnit(TextUnit.Line);
      r.ScrollIntoView(true);
      System.Threading.Thread.Sleep(350); // 다시 그릴 시간
      return Snap(0);
    }, timeoutMs, e => new Step { Error = e });
  }

  // 지금 보이는 마지막 줄을 맨 위로 (그 줄만큼 겹치게) — 스크롤한 거리는 그 줄이 움직인 거리
  public static Step Next(int timeoutMs) {
    return Run(() => {
      if (sSel == null) return new Step { Error = "no selection" };
      var vis = sPat.GetVisibleRanges();
      if (vis.Length == 0) return new Step { Error = "no visible range" };
      var r = vis[vis.Length - 1].Clone();
      r.MoveEndpointByRange(TextPatternRangeEndpoint.Start, r, TextPatternRangeEndpoint.End);
      r.ExpandToEnclosingUnit(TextUnit.Line);
      double before = Top(r);
      r.ScrollIntoView(true);
      System.Threading.Thread.Sleep(350);
      double after = Top(r);
      return Snap(double.IsNaN(before) || double.IsNaN(after) ? 0 : before - after);
    }, timeoutMs, e => new Step { Error = e });
  }

  // 원래 스크롤 위치로 (못 하면 선택 첫 줄이 보이게)
  public static Step Restore(int timeoutMs) {
    return Run(() => {
      try {
        if (sScroll != null && sV >= 0) {
          sScroll.SetScrollPercent(sScroll.Current.HorizontallyScrollable ? sH : ScrollPattern.NoScroll, sV);
        } else if (sSel != null) {
          var r = sSel.Clone();
          r.MoveEndpointByRange(TextPatternRangeEndpoint.End, r, TextPatternRangeEndpoint.Start);
          r.ScrollIntoView(true);
        }
      } finally {
        sPat = null; sSel = null; sEl = null; sScroll = null;
      }
      return new Step { Ok = true };
    }, timeoutMs, e => new Step { Error = e });
  }
}
'@
  $script:selApiLoaded = $true
}

# 마지막으로 끈(드래그) 시작·끝 점 — UI 자동화로 선택 위치를 읽을 수 없는 앱(카카오톡 등)에서 강조색을 찾을 자리
# 왼쪽 단추를 누른 채 8px 넘게 움직였다 뗀 것만. 좌표는 실제 화면 픽셀. 위치만 기억하고 다른 것은 하지 않는다.
function Initialize-DragApi {
  if ($script:dragApiLoaded) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MkDrag {
  delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

  static LowLevelMouseProc proc = Hook; // 훅이 쓰는 동안 사라지지 않게
  static IntPtr hook = IntPtr.Zero;
  static bool down; static int downX, downY; static IntPtr downWin;
  public static int X0, Y0, X1, Y1;
  public static long Hwnd;
  public static DateTime At = DateTime.MinValue;

  public static void Start() {
    if (hook != IntPtr.Zero) return;
    var t = new System.Threading.Thread(() => {
      try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
      hook = SetWindowsHookEx(14, proc, GetModuleHandle(null), 0); // WH_MOUSE_LL
      MSG m;
      while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    });
    t.IsBackground = true;
    t.Start();
  }

  static IntPtr Hook(int code, IntPtr w, IntPtr l) {
    try {
      if (code >= 0) {
        int msg = w.ToInt32();
        if (msg == 0x201 || msg == 0x202) {
          var s = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
          if (msg == 0x201) { down = true; downX = s.pt.X; downY = s.pt.Y; downWin = GetAncestor(WindowFromPoint(s.pt), 2); }
          else if (down) {
            down = false;
            if (Math.Abs(s.pt.X - downX) + Math.Abs(s.pt.Y - downY) > 8) {
              X0 = downX; Y0 = downY; X1 = s.pt.X; Y1 = s.pt.Y; Hwnd = downWin.ToInt64(); At = DateTime.UtcNow;
            }
          }
        }
      }
    } catch { }
    return CallNextHookEx(hook, code, w, l);
  }

  public static bool SameAsForeground() { return GetAncestor(GetForegroundWindow(), 2).ToInt64() == Hwnd; }
  public static int[] ForegroundRect() {
    IntPtr old = IntPtr.Zero;
    try { old = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
    try { RECT r; return GetWindowRect(GetForegroundWindow(), out r) ? new[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top } : null; }
    finally { if (old != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(old); } catch { } } }
  }
}
'@
  $script:dragApiLoaded = $true
}

function Get-LastDrag {
  Initialize-DragApi
  if ([MkDrag]::At -eq [DateTime]::MinValue) { return '{"found":false}' }
  $out = @{
    found = $true
    x0 = [MkDrag]::X0; y0 = [MkDrag]::Y0; x1 = [MkDrag]::X1; y1 = [MkDrag]::Y1
    ageMs = [Math]::Round(([DateTime]::UtcNow - [MkDrag]::At).TotalMilliseconds)
    sameWindow = [MkDrag]::SameAsForeground()
  }
  $wr = [MkDrag]::ForegroundRect()
  if ($wr) { $out.window = @{ x = $wr[0]; y = $wr[1]; width = $wr[2]; height = $wr[3] } }
  $fg = [MkWin]::GetForegroundWindow()
  $out.title = [MkWin]::Title($fg)
  $procId = [uint32]0
  [void][MkWin]::GetWindowThreadProcessId($fg, [ref]$procId)
  $out.process = ''
  try { $out.process = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  return ($out | ConvertTo-Json -Compress)
}

function Get-SelectionRect {
  Initialize-SelApi
  $r = [MkSel]::Find(2500) # 처음 물을 때 앱(브라우저 등)이 접근성 정보를 만드느라 늦을 수 있다
  if ($r.Error) { return (@{ found = $false; error = $r.Error } | ConvertTo-Json -Compress) }
  $out = @{ found = $r.Found; more = $r.More }
  if ($r.Found) {
    $out.x = [Math]::Round($r.X); $out.y = [Math]::Round($r.Y); $out.width = [Math]::Round($r.W); $out.height = [Math]::Round($r.H)
    $out.view = @{ x = [Math]::Round($r.VX); y = [Math]::Round($r.VY); width = [Math]::Round($r.VW); height = [Math]::Round($r.VH) }
    $out.window = [MkWin]::Title([IntPtr]$r.Hwnd)
    $out.process = ''
    try { $out.process = (Get-Process -Id $r.Pid -ErrorAction Stop).ProcessName } catch { }
  }
  return ($out | ConvertTo-Json -Compress)
}

# 선택 범위를 따라 스크롤: start(선택 첫 줄을 맨 위로) · next(보이는 마지막 줄을 맨 위로) · restore(원래 자리로)
function Invoke-SelScroll([string]$mode) {
  Initialize-SelApi
  $st = switch ($mode) {
    'start' { [MkSel]::Start(4000) }
    'next' { [MkSel]::Next(4000) }
    'restore' { [MkSel]::Restore(3000) }
    default { $null }
  }
  if (-not $st) { return '{"ok":false,"error":"unknown mode"}' }
  if ($st.Error) { return (@{ ok = $false; error = $st.Error } | ConvertTo-Json -Compress) }
  $out = @{ ok = $true; atEnd = $st.AtEnd; moved = [Math]::Round($st.Moved) }
  if ($st.VW -gt 0) { $out.view = @{ x = [Math]::Round($st.VX); y = [Math]::Round($st.VY); width = [Math]::Round($st.VW); height = [Math]::Round($st.VH) } }
  if ($st.HasSel) { $out.sel = @{ x = [Math]::Round($st.SX); y = [Math]::Round($st.SY); width = [Math]::Round($st.SW); height = [Math]::Round($st.SH) } }
  return ($out | ConvertTo-Json -Compress)
}

function Invoke-Capture([string]$dir, [bool]$noCopy, [uint32]$onlyPid = 0) {
  Initialize-WinApi
  $hwnd = [MkWin]::GetForegroundWindow()
  $title = [MkWin]::Title($hwnd)
  $procId = [uint32]0
  [void][MkWin]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $process = ''
  try { $process = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  $changed = $false
  $copySkipped = $false
  # 점검용 안전장치: 맨 앞 창이 지정한 프로세스가 아니면 키를 보내지 않는다 (사용자의 다른 앱에 Ctrl+C 가 가지 않게)
  if (-not $noCopy -and $onlyPid -gt 0 -and $procId -ne $onlyPid) { $noCopy = $true; $copySkipped = $true }
  if (-not $noCopy) {
    # 단축키에서 손을 뗄 때까지 (누른 채로 Ctrl+C 를 보내면 Ctrl+Alt+C 가 되어 버림)
    $until = (Get-Date).AddMilliseconds(1500)
    while ([MkWin]::KeysDown() -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 15 }
    $seq = [MkWin]::GetClipboardSequenceNumber()
    [MkWin]::CtrlC()
    $until = (Get-Date).AddMilliseconds(1000)
    while ((Get-Date) -lt $until) {
      if ([MkWin]::GetClipboardSequenceNumber() -ne $seq) { $changed = $true; break }
      Start-Sleep -Milliseconds 20
    }
    if ($changed) { Start-Sleep -Milliseconds 150 } # 앱이 여러 형식을 다 넣을 시간
  }
  $manifest = Save-Clipboard $dir
  $manifest.changed = $changed
  $manifest.copySkipped = $copySkipped
  $manifest.window = $title
  $manifest.process = $process
  return ($manifest | ConvertTo-Json -Compress)
}

switch ($Action) {
  'text' {
    $data = New-Data
    $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [IO.File]::ReadAllText($TextFile, $utf8))
    Set-ClipboardData $data
  }
  'html' {
    $data = New-Data
    $bytes = ConvertTo-CfHtml ([IO.File]::ReadAllText($HtmlFile, $utf8))
    $data.SetData('HTML Format', (New-Object IO.MemoryStream (, $bytes)))
    if ($TextFile) { $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [IO.File]::ReadAllText($TextFile, $utf8)) }
    if ($ImageFile) { $data.SetImage([System.Drawing.Image]::FromFile($ImageFile)) }
    Set-ClipboardData $data
  }
  'image' {
    $data = New-Data
    $data.SetImage([System.Drawing.Image]::FromFile($ImageFile))
    Set-ClipboardData $data
  }
  'files' {
    $list = New-Object System.Collections.Specialized.StringCollection
    foreach ($line in [IO.File]::ReadAllLines($ListFile, $utf8)) { if ($line) { [void]$list.Add($line) } }
    $data = New-Data
    $data.SetFileDropList($list)
    Set-ClipboardData $data
  }
  'backup' {
    Write-Output (Save-Clipboard $Dir | ConvertTo-Json -Compress)
  }
  'restore' {
    $manifest = Get-Content -Raw (Join-Path $Dir 'manifest.json') | ConvertFrom-Json
    $data = New-Data
    $any = $false
    if ($manifest.files) {
      $list = New-Object System.Collections.Specialized.StringCollection
      foreach ($line in [IO.File]::ReadAllLines((Join-Path $Dir 'files.txt'), $utf8)) { if ($line) { [void]$list.Add($line) } }
      $data.SetFileDropList($list); $any = $true
    }
    if ($manifest.text) { $data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [IO.File]::ReadAllText((Join-Path $Dir 'text.txt'), $utf8)); $any = $true }
    if ($manifest.html) { $data.SetData('HTML Format', (New-Object IO.MemoryStream (, [IO.File]::ReadAllBytes((Join-Path $Dir 'html.bin'))))); $any = $true }
    if ($manifest.image) { $data.SetImage([System.Drawing.Image]::FromFile((Join-Path $Dir 'image.png'))); $any = $true }
    if ($any) { Set-ClipboardData $data } else { [System.Windows.Forms.Clipboard]::Clear() }
    Write-Output ($manifest | ConvertTo-Json -Compress)
  }
  'capture' {
    Write-Output (Invoke-Capture $Dir $NoCopy.IsPresent)
  }
  # 상주 모드: 앱이 켜질 때 한 번 띄워 두고 한 줄씩 명령을 받는다 (매번 PowerShell 을 띄우는 지연 없음)
  #   capture<TAB><폴더 경로 base64(UTF-8)>[<TAB>nocopy]  ->  JSON 한 줄
  #   selrect  ->  {"found":true,"more"(화면 밖까지 선택),"x","y","width","height","view"(화면 픽셀),"window","process"} 또는 {"found":false}
  #   selscroll<TAB>start|next|restore  ->  {"ok","atEnd","moved","view","sel"}  (스크롤 캡처)
  #   lastdrag  ->  {"found","x0","y0","x1","y1"(화면 픽셀),"ageMs","sameWindow","window","title","process"}  (마지막으로 끈 곳)
  'serve' {
    try { [Console]::OutputEncoding = $utf8 } catch { }
    Initialize-WinApi
    try { Initialize-SelApi } catch { } # 미리 컴파일해 두어 처음 누를 때 늦지 않게 (실패하면 selrect 가 오류로 답함)
    try { Initialize-DragApi; [MkDrag]::Start() } catch { } # 마지막 드래그 위치 기억 (UI 자동화를 쓰지 않는 앱용)
    [Console]::Out.WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
      $parts = $line.Split([char]9)
      try {
        if ($parts[0] -eq 'capture') {
          $dir = $utf8.GetString([Convert]::FromBase64String($parts[1]))
          $mode = if ($parts.Length -gt 2) { $parts[2] } else { '' }
          $only = if ($mode -like 'only:*') { [uint32]$mode.Substring(5) } else { 0 }
          $out = Invoke-Capture $dir ($mode -eq 'nocopy') $only
        } elseif ($parts[0] -eq 'selrect') {
          $out = Get-SelectionRect
        } elseif ($parts[0] -eq 'lastdrag') {
          $out = Get-LastDrag
        } elseif ($parts[0] -eq 'selscroll') {
          $out = Invoke-SelScroll $parts[1]
        } elseif ($parts[0] -eq 'ping') {
          $out = '{"pong":true}'
        } else {
          $out = '{"error":"unknown command"}'
        }
      } catch {
        $out = (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
      }
      [Console]::Out.WriteLine($out)
      [Console]::Out.Flush()
    }
  }
}
