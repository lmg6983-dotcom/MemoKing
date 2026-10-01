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
  Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
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

  public class Result { public bool Found; public double X, Y, W, H; public uint Pid; public long Hwnd; public string Error; }

  public static Result Find(int timeoutMs) {
    var task = Task.Run(() => FindNow());
    if (!task.Wait(timeoutMs)) return new Result { Error = "timeout" };
    return task.Result;
  }

  class Box {
    public double L = double.MaxValue, T = double.MaxValue, R = double.MinValue, B = double.MinValue;
    public bool Any;
    public void Add(System.Windows.Rect rc) {
      if (rc.IsEmpty || double.IsInfinity(rc.X) || double.IsNaN(rc.X) || rc.Width < 1 || rc.Height < 1) return;
      L = Math.Min(L, rc.Left); T = Math.Min(T, rc.Top); R = Math.Max(R, rc.Right); B = Math.Max(B, rc.Bottom); Any = true;
    }
  }

  static Result FindNow() {
    IntPtr old = IntPtr.Zero;
    try { old = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // PER_MONITOR_AWARE_V2 (Windows 10 1607+)
    try {
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
          foreach (TextPatternRange range in ((TextPattern)pat).GetSelection()) {
            string text = range.GetText(256) ?? "";
            AutomationElement[] kids = new AutomationElement[0];
            try { kids = range.GetChildren(); } catch { }
            if (text.Trim().Length == 0 && kids.Length == 0) continue; // 커서만 있음
            foreach (var rc in range.GetBoundingRectangles()) box.Add(rc);
            foreach (var k in kids) {
              try { if (!k.Current.IsOffscreen) box.Add(k.Current.BoundingRectangle); } catch { }
            }
          }
        }
        if (!box.Any) el = walker.GetParent(el);
      }
      if (!box.Any) return res;
      RECT wr;
      if (GetWindowRect(fg, out wr)) {
        box.L = Math.Max(box.L, wr.Left); box.T = Math.Max(box.T, wr.Top);
        box.R = Math.Min(box.R, wr.Right); box.B = Math.Min(box.B, wr.Bottom);
      }
      if (box.R - box.L < 4 || box.B - box.T < 4) return res;
      res.Found = true; res.X = box.L; res.Y = box.T; res.W = box.R - box.L; res.H = box.B - box.T;
      return res;
    } catch (Exception e) {
      return new Result { Error = e.Message };
    } finally {
      if (old != IntPtr.Zero) { try { SetThreadDpiAwarenessContext(old); } catch { } }
    }
  }
}
'@
  $script:selApiLoaded = $true
}

function Get-SelectionRect {
  Initialize-SelApi
  $r = [MkSel]::Find(1500)
  if ($r.Error) { return (@{ found = $false; error = $r.Error } | ConvertTo-Json -Compress) }
  $out = @{ found = $r.Found }
  if ($r.Found) {
    $out.x = [Math]::Round($r.X); $out.y = [Math]::Round($r.Y); $out.width = [Math]::Round($r.W); $out.height = [Math]::Round($r.H)
    $out.window = [MkWin]::Title([IntPtr]$r.Hwnd)
    $out.process = ''
    try { $out.process = (Get-Process -Id $r.Pid -ErrorAction Stop).ProcessName } catch { }
  }
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
  #   selrect  ->  {"found":true,"x","y","width","height"(화면 픽셀),"window","process"} 또는 {"found":false}
  'serve' {
    try { [Console]::OutputEncoding = $utf8 } catch { }
    Initialize-WinApi
    try { Initialize-SelApi } catch { } # 미리 컴파일해 두어 처음 누를 때 늦지 않게 (실패하면 selrect 가 오류로 답함)
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
