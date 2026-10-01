# Popup notification watcher for MemoKing.
# Some apps (e.g. KakaoTalk PC) show their own small popup windows instead of Windows notifications,
# so those never reach the Action Center database. This helper watches for such popups and reads them:
#   1) UI Automation text of the popup window
#   2) if none, captures the window (PrintWindow) and reads it with the OCR built into Windows (Windows.Media.Ocr)
# One JSON line per new popup text on stdout: {"process","pid","hwnd","windowTitle","lines":[...],"via":"uia|ocr","image":"<png>"}
# Requires Windows PowerShell 5.1 (WinRT OCR):  powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File popup-watch.ps1 -Processes KakaoTalk -Dir <tmp>
param(
  [string]$Processes = 'KakaoTalk',   # process names without .exe, comma separated
  [int]$OnlyPid = 0,                  # self-test: watch only this process id (names ignored)
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$IntervalMs = 700,
  [switch]$ForceOcr
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
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public class Win { public long Hwnd; public uint Pid; public int X, Y, W, H; public string Title; }

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
      if (w < 120 || w > 720 || hh < 40 || hh > 480) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
      list.Add(new Win { Hwnd = h.ToInt64(), Pid = pid, X = r.Left, Y = r.Top, W = w, H = hh, Title = sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // 창을 그림으로 (가려져 있어도). 바뀌었는지 볼 지문(작은 표본)도 함께
  public static Bitmap Capture(long hwnd, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(new IntPtr(hwnd), hdc, 2);
      g.ReleaseHdc(hdc);
      if (!ok) { bmp.Dispose(); return null; }
    }
    return bmp;
  }
  public static string Fingerprint(Bitmap b) {
    long sum = 0; int n = 0;
    for (int y = 2; y < b.Height; y += Math.Max(1, b.Height / 16))
      for (int x = 2; x < b.Width; x += Math.Max(1, b.Width / 24)) { sum = sum * 31 + b.GetPixel(x, y).ToArgb(); n++; }
    return n + ":" + sum.ToString();
  }
}
'@

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

function Read-Ocr([string]$png) {
  if (-not $ocr) { return @() }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    # 한글 OCR 은 글자마다 띄어 주므로 단어 사이 간격으로 다시 붙인다
    $lines = foreach ($line in $result.Lines) {
      $text = ''
      $prev = $null
      foreach ($w in $line.Words) {
        if ($prev) {
          $gap = $w.BoundingRect.X - ($prev.BoundingRect.X + $prev.BoundingRect.Width)
          if ($gap -gt ($prev.BoundingRect.Height * 0.35)) { $text += ' ' }
        }
        $text += $w.Text
        $prev = $w
      }
      $text.Trim()
    }
    @($lines | Where-Object { $_ })
  } finally { $stream.Dispose() }
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
          $fp = [MkPopup]::Fingerprint($bmp)
          $s = $state[$w.Hwnd]
          if (-not $s) { $s = @{ fp = ''; stable = 0; sent = '' }; $state[$w.Hwnd] = $s }
          if ($s.fp -ne $fp) { $s.fp = $fp; $s.stable = 0; continue }   # 그려지는 중 → 다음 차례에
          $s.stable++
          if ($s.stable -ne 1) { continue }                                # 모양이 그대로면 한 번만 읽는다
          $png = Join-Path $Dir ("popup-{0}-{1}.png" -f $w.Hwnd, [DateTime]::Now.Ticks)
          $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
          $via = 'uia'
          $lines = @()
          if (-not $ForceOcr) { $lines = @(Read-Uia $w.Hwnd $w.Title) }
          if (-not $lines.Count) { $via = 'ocr'; $lines = @(Read-Ocr $png) }
          $key = ($lines -join "`n")
          if (-not $key -or $key -eq $s.sent) { Remove-Item $png -ErrorAction SilentlyContinue; continue }
          $s.sent = $key
          $proc = (Get-Process -Id $w.Pid -ErrorAction SilentlyContinue).ProcessName
          [Console]::Out.WriteLine((@{ process = $proc; pid = $w.Pid; hwnd = $w.Hwnd; windowTitle = $w.Title; lines = $lines; via = $via; image = $png } | ConvertTo-Json -Compress))
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
