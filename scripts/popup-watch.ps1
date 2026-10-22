# Popup notification watcher for MemoKing.
# Some apps (e.g. KakaoTalk PC) show their own small popup windows instead of Windows notifications,
# so those never reach the Action Center database. This helper watches for such popups and reads them:
#   1) UI Automation text of the popup window
#   2) if none, MSAA (IAccessible name / value / description) of the window and its children
#   3) if none, text of the child windows (WM_GETTEXT)
#   4) captures the window (PrintWindow) and reads it with the OCR built into Windows (Windows.Media.Ocr).
#      OCR always runs; text from 1)~3) is used only when it covers what OCR sees (some apps expose only junk names).
#      For OCR the capture is made opaque (layered/GDI windows leave alpha at 0 and OCR then sees an empty canvas)
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

  // 글자 인식용 그림: 알파를 무시해 불투명하게 (GDI 로 그린 글자는 알파가 0 이라 그대로면 빈 그림으로 보인다)
  // 그리고 factor 배로 키운다 (작은 글자는 키우면 훨씬 잘 읽힌다)
  public static Bitmap OcrImage(Bitmap src, double factor) {
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
    if (factor <= 1.01) return opaque;
    int w = (int)Math.Round(src.Width * factor), h = (int)Math.Round(src.Height * factor);
    var big = new Bitmap(w, h, PixelFormat.Format32bppArgb);
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
    return big;
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
          $ocrUnit = 1.0
          $factor = [Math]::Max(1.0, [Math]::Min(3.0 / $w.Scale, 2200.0 / [Math]::Max($w.W, $w.H)))
          try {
            $big = [MkPopup]::OcrImage($bmp, $factor)
            $ocrPng = "$png.ocr.png"
            $big.Save($ocrPng, [System.Drawing.Imaging.ImageFormat]::Png)
            $ocrUnit = $factor * $w.Scale
            $big.Dispose()
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
          if ((-not $key -and $via -ne 'ocr') -or $dedupeKey -eq $s.sent) { Remove-Item $png, $ocrPng -ErrorAction SilentlyContinue; continue }
          $s.sent = $dedupeKey
          $proc = (Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).ProcessName
          $msg = [ordered]@{ process = $proc; pid = $w.Pid; hwnd = $w.Hwnd; windowTitle = $w.Title; lines = @($lines); via = $via; image = $png; size = $size }
          if ($via -eq 'ocr') { $msg['boxes'] = @($boxes); $msg['ocrImage'] = $ocrPng; $msg['ocrUnit'] = [Math]::Round($ocrUnit, 4) }
          else { Remove-Item $ocrPng -ErrorAction SilentlyContinue }
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
