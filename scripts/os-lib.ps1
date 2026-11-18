# 메모킹 OS 수준 시험 공용 (os-e2e.ps1 · os-scenario.ps1 이 dot-source 한다)
#   진짜 입력: Windows SendInput · OLE 끌기 — 화면 안에서 흉내 내는 점검(smoke.js)이 못 보는 Windows ↔ WebView2 사이까지
#   요소 자리: 개발판의 원격 디버깅(MEMOKING_DEBUG_PORT, main.rs browser_args)으로 화면에 묻고, 누르기 · 끌기는 진짜 마우스로
#   안전: 시험판(디버그 빌드)만 — 자동 시작 등록이 꺼져 있다 · 따로 된 설정(--profile=e2e) · 임시 메모 폴더
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('W' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class W {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  // 화면 좌표를 실제 픽셀로 (배율 125% 여도 누를 자리가 어긋나지 않게)
  public static void DpiAware() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
  public static RECT Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  /// 그 프로세스들의 보이는 큰 창 (스티커 · 말풍선 같은 작은 창은 뺀다)
  public static List<IntPtr> Windows(uint[] pids) {
    var set = new HashSet<uint>(pids); var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (set.Contains(pid) && IsWindowVisible(h)) { var r = Rect(h); if (r.R - r.L >= 200 && r.B - r.T >= 150) list.Add(h); } return true; }, IntPtr.Zero);
    return list;
  }
  const uint MOVE = 1, LDOWN = 2, LUP = 4;
  static void Glide(int x0, int y0, int x1, int y1, int steps, int ms) {
    for (int i = 1; i <= steps; i++) { SetCursorPos(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); mouse_event(MOVE, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(ms); }
  }
  /// 사람처럼: 누르고 → 조금 움직여 끌기 시작 → 목표로 미끄러지듯 → 잠깐 머물고(놓을 자리 표시) → 놓기
  public static void Drag(int x0, int y0, int x1, int y1) {
    SetCursorPos(x0, y0); Thread.Sleep(120); mouse_event(LDOWN, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(120);
    Glide(x0, y0, x0 + 10, y0 + 10, 5, 20); Glide(x0 + 10, y0 + 10, x1, y1, 30, 15);
    Thread.Sleep(400); Glide(x1, y1, x1 + 2, y1 + 1, 2, 40); Thread.Sleep(250);
    mouse_event(LUP, 0, 0, 0, UIntPtr.Zero);
  }
  public static Thread DragLater(int x0, int y0, int x1, int y1, int delayMs) {
    var t = new Thread(() => { Thread.Sleep(delayMs); Drag(x0, y0, x1, y1); }); t.IsBackground = true; t.Start(); return t;
  }
  public static void Click(int x, int y) { SetCursorPos(x, y); Thread.Sleep(80); mouse_event(LDOWN, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(50); mouse_event(LUP, 0, 0, 0, UIntPtr.Zero); }
  /// 키 하나 또는 조합 (Ctrl+Shift+D 면 0x11, 0x10, 0x44) — 차례로 누르고 거꾸로 뗀다
  public static void Keys(params byte[] vks) {
    foreach (var k in vks) { keybd_event(k, 0, 0, UIntPtr.Zero); Thread.Sleep(25); }
    for (int i = vks.Length - 1; i >= 0; i--) { keybd_event(vks[i], 0, 2, UIntPtr.Zero); Thread.Sleep(25); }
  }
  /// 글자 그대로 치기 (한글도 — 입력기를 거치지 않는 유니코드 입력). \n 은 Enter
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\n') { Keys(0x0D); Thread.Sleep(40); continue; }
      var a = new INPUT[2];
      a[0].type = 1; a[0].u.ki.wScan = c; a[0].u.ki.dwFlags = 4;
      a[1].type = 1; a[1].u.ki.wScan = c; a[1].u.ki.dwFlags = 4 | 2;
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT))); Thread.Sleep(35);
    }
  }
}
'@
}
[W]::DpiAware()

$script:Installed = "$env:LOCALAPPDATA\MemoKing\MemoKing.exe"
$script:CdpPort = 9333

function Wait-Until($sec, [scriptblock]$fn) { $t = [DateTime]::Now.AddSeconds($sec); while ([DateTime]::Now -lt $t) { $v = & $fn; if ($v) { return $v }; Start-Sleep -Milliseconds 200 }; return $null }

# ---------- 시험판 켜기 · 끄기 (따로 된 설정 · 임시 메모 폴더) ----------
function Initialize-TestRun($exe) {
  if (-not (Test-Path $exe)) { throw "시험판이 없어요: $exe — 메모킹-시험판.cmd 로 먼저 받아 풀어 주세요" }
  $script:Exe = (Resolve-Path $exe).Path
  if ($script:Exe -ieq $script:Installed) { throw '설치된 정식판으로는 시험하지 않아요 (자동 시작 등록을 건드릴 수 있어요). 시험판 exe 를 주세요' }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $script:Work = Join-Path $env:TEMP "memoking-os-e2e\$stamp"
  $script:Vault = Join-Path $script:Work 'vault'
  $script:Shots = Join-Path $script:Work 'shots'
  $script:Files = Join-Path $script:Work 'files'
  New-Item -ItemType Directory -Force $script:Vault, $script:Shots, $script:Files | Out-Null
  $profileDir = Join-Path $env:APPDATA 'MemoKing-e2e'
  if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir }
  New-Item -ItemType Directory -Force $profileDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $profileDir 'settings.json'), (@{ vaultPath = $script:Vault; tutorialDone = $true } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
  # 끌어 놓을 파일: 눈에 띄는 분홍 사진 · 한 쪽짜리 PDF
  $script:Png = Join-Path $script:Files '시험 사진.png'
  $bmp = New-Object System.Drawing.Bitmap 160, 120
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 255)); $g.Dispose()
  $bmp.Save($script:Png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $script:Pdf = Join-Path $script:Files '시험 문서.pdf'
  [IO.File]::WriteAllText($script:Pdf, "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>endobj`ntrailer<</Root 1 0 R>>`n%%EOF`n")
  $script:Results = New-Object System.Collections.Generic.List[object]
  $script:WasRunning = [bool](Get-Process MemoKing -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $script:Installed })
  Get-Process memoking -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 1
}
function Start-TestApp([string[]]$more = @()) {
  $env:MEMOKING_DEBUG_PORT = "$script:CdpPort"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$script:CdpPort"
  Start-Process $script:Exe -ArgumentList (@('--profile=e2e') + $more)
}
function Get-TestPids { @(Get-Process memoking -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $script:Exe } | ForEach-Object { [uint32]$_.Id }) }
function Stop-TestRun {
  Get-Process memoking -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $script:Exe } | Stop-Process -Force
  Remove-Item Env:MEMOKING_DEBUG_PORT, Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  if ($script:WasRunning -and (Test-Path $script:Installed)) { Start-Process $script:Installed }
}
function Write-Report {
  $report = Join-Path $script:Work '결과.txt'
  $script:Results | Format-Table -AutoSize | Out-String -Width 220 | Out-File -Encoding utf8 $report
  $ok = @($script:Results | Where-Object 결과 -eq '통과').Count
  Write-Host ''
  Write-Host "통과 $ok / $($script:Results.Count)"
  Write-Host "결과: $report"
  Write-Host "화면 사진: $script:Shots"
}
function Add-Result($name, $ok, $detail = '') {
  $script:Results.Add([pscustomobject]@{ 시험 = $name; 결과 = $(if ($ok) { '통과' } else { '실패' }); 자세히 = $detail })
  Write-Host ("{0}  {1}  {2}" -f $(if ($ok) { 'O' } else { 'X' }), $name, $detail)
}

# ---------- 화면 사진 · 메모 폴더 ----------
function Save-ShotRect($name, $l, $t, $w, $h) {
  $b = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
  [System.Drawing.Graphics]::FromImage($b).CopyFromScreen([int]$l, [int]$t, 0, 0, $b.Size)
  $b.Save((Join-Path $script:Shots "$name.png")); return $b
}
function Save-Shot($name, $h) { $r = [W]::Rect($h); Save-ShotRect $name $r.L $r.T ($r.R - $r.L) ($r.B - $r.T) }
function Get-VaultText { (Get-ChildItem $script:Vault -Filter *.md -Recurse -ErrorAction SilentlyContinue | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n" }
# 창 사진에서 그 색 덩어리의 가운데 (못 찾으면 $null)
function Find-Color($bmp, [scriptblock]$match) {
  $xs = 0; $ys = 0; $n = 0
  for ($y = 0; $y -lt $bmp.Height; $y += 4) { for ($x = 0; $x -lt $bmp.Width; $x += 4) { if (& $match $bmp.GetPixel($x, $y)) { $xs += $x; $ys += $y; $n++ } } }
  if ($n -lt 20) { return $null }; return @([int]($xs / $n), [int]($ys / $n))
}

# ---------- 파일 하나를 진짜로 끌어 놓기 ----------
#   작은 창(끌기 시작점)에서 OLE 끌기를 시작해 마우스를 목표로 옮겨 놓는다. 받은 쪽이 받아들였는지(Copy)를 돌려준다
function Invoke-FileDrop($path, $x, $y) {
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = 'FixedToolWindow'; $form.TopMost = $true; $form.StartPosition = 'Manual'
  $form.Size = New-Object System.Drawing.Size 160, 90
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Location = New-Object System.Drawing.Point ($screen.Left + 20), ($screen.Bottom - 120)
  $form.Text = '끌기 시작점'
  $script:dropEffect = 'None'
  $data = New-Object System.Windows.Forms.DataObject
  $list = New-Object System.Collections.Specialized.StringCollection; [void]$list.Add($path); $data.SetFileDropList($list)
  $form.Add_MouseDown({ $script:dropEffect = [string]$form.DoDragDrop($data, [System.Windows.Forms.DragDropEffects]::Copy); $form.Close() })
  $form.Add_Shown({ $c = $form.PointToScreen((New-Object System.Drawing.Point 80, 30)); [void][W]::DragLater($c.X, $c.Y, [int]$x, [int]$y, 300) })
  $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 15000; $timer.Add_Tick({ $form.Close() }); $timer.Start()
  [void]$form.ShowDialog(); $timer.Stop(); $form.Dispose()
  return $script:dropEffect
}

# ---------- 화면에 묻기 (원격 디버깅) ----------
function Get-Pages { try { @(Invoke-RestMethod "http://127.0.0.1:$script:CdpPort/json/list" -TimeoutSec 3 | Where-Object { $_.type -eq 'page' }) } catch { @() } }
function Invoke-Js($page, [string]$expr) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $none = [Threading.CancellationToken]::None
  if (-not $ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $none).Wait(5000)) { throw '화면에 연결하지 못함' }
  try {
    $msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expr; returnByValue = $true; awaitPromise = $true } } | ConvertTo-Json -Compress -Depth 6
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    [void]$ws.SendAsync((New-Object ArraySegment[byte] (, $bytes)), 'Text', $true, $none).Wait(5000)
    while ($true) {
      $ms = New-Object IO.MemoryStream
      do {
        $buf = New-Object byte[] 65536
        $seg = New-Object ArraySegment[byte] (, $buf)
        $task = $ws.ReceiveAsync($seg, $none)
        if (-not $task.Wait(15000)) { throw '화면이 답하지 않음' }
        $ms.Write($buf, 0, $task.Result.Count)
      } while (-not $task.Result.EndOfMessage)
      $res = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
      if ($res.id -ne 1) { continue }
      if ($res.result.exceptionDetails) { throw "화면 오류: $($res.result.exceptionDetails.exception.description)" }
      return $res.result.result.value
    }
  } finally { $ws.Dispose() }
}
# 보이는 화면 하나 (url 에 그 이름) — 숨겨 둔 예비 창은 빼고
function Find-Page($urlPart, $exclude = @()) {
  foreach ($p in Get-Pages) {
    if ($p.url -notlike "*$urlPart*" -or $exclude -contains $p.id) { continue }
    try { if ((Invoke-Js $p 'document.visibilityState') -eq 'visible') { return $p } } catch {}
  }
  return $null
}
# 요소의 화면 자리 (실제 픽셀) — 없거나 안 보이면 $null. part: 요소 안 어디 (0..1, 기본 가운데)
function Get-Spot($page, [string]$sel, $fx = 0.5, $fy = 0.5) {
  $js = "(() => { const e = document.querySelector($(ConvertTo-Json $sel)); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width || !r.height) return null; const d = devicePixelRatio; return { x: Math.round((screenX + r.left + r.width * $fx) * d), y: Math.round((screenY + r.top + r.height * $fy) * d) }; })()"
  Invoke-Js $page $js
}
function Click-El($page, [string]$sel, $fx = 0.5, $fy = 0.5) {
  $s = Get-Spot $page $sel $fx $fy
  if (-not $s) { throw "찾지 못함: $sel" }
  [W]::Click($s.x, $s.y); Start-Sleep -Milliseconds 350
}
function Test-Js($page, [string]$expr) { [bool](Invoke-Js $page "Boolean($expr)") }
# 창 자리 (실제 픽셀)
function Get-WinPos($page) { Invoke-Js $page '({ x: Math.round(screenX * devicePixelRatio), y: Math.round(screenY * devicePixelRatio) })' }
# 그 요소를 잡고 끌어 창이 그만큼 옮겨지는가 → @(맞음, "옮긴 만큼")
function Test-WindowDrag($page, [string]$sel, $dx = 60, $dy = 40, $fx = 0.5, $fy = 0.5) {
  $s = Get-Spot $page $sel $fx $fy
  if (-not $s) { return @($false, "잡을 곳 없음: $sel") }
  $a = Get-WinPos $page
  [W]::Drag($s.x, $s.y, $s.x + $dx, $s.y + $dy); Start-Sleep -Milliseconds 500
  $b = Get-WinPos $page
  $mx = $b.x - $a.x; $my = $b.y - $a.y
  return @(([Math]::Abs($mx - $dx) -le 14 -and [Math]::Abs($my - $dy) -le 14), "옮긴 만큼 ($mx, $my)")
}
