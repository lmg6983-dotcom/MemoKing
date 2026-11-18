# 메모킹 OS 수준 시험 — 진짜 마우스(Windows 입력)로 끌어 놓기 · 창 옮기기를 해 보고 결과를 적는다
#   화면 안에서 흉내 내는 점검(desktop-rs/app/smoke.js)이 못 보는 것: Windows ↔ WebView2 사이의 끌어 놓기(OLE),
#   CSS 창 끌기 영역이 실제로 창을 옮기는지. 시험하는 동안 마우스 · 키보드를 만지지 않는다
#
#   - 시험판(디버그 빌드)만: 자동 시작 등록이 꺼져 있어 사용자의 자동 시작 항목을 건드리지 않는다 (files.rs auto_start)
#   - 따로 된 설정(--profile=e2e → %APPDATA%\MemoKing-e2e)과 임시 메모 폴더 — 실제 메모는 건드리지 않는다
#   - 같은 앱은 하나만 켜지므로(single-instance) 켜져 있는 메모킹을 잠깐 끄고, 끝나면 다시 켠다
#
#   powershell -ExecutionPolicy Bypass -File scripts\os-e2e.ps1 [-Exe 시험판.exe] [-Rounds 3]
param(
  [string]$Exe = "$env:LOCALAPPDATA\MemoKing-test\memoking.exe",
  [int]$Rounds = 3
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class W {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // 화면 좌표를 실제 픽셀로 (창 크기 배율이 125% 여도 끌 자리가 어긋나지 않게)
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
  public static void Key(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); Thread.Sleep(40); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
'@
[W]::DpiAware()

if (-not (Test-Path $Exe)) { throw "시험판이 없어요: $Exe — 메모킹-시험판.cmd 로 먼저 받아 풀어 주세요" }
$installed = "$env:LOCALAPPDATA\MemoKing\MemoKing.exe"
if ((Resolve-Path $Exe).Path -ieq $installed) { throw '설치된 정식판으로는 시험하지 않아요 (자동 시작 등록을 건드릴 수 있어요). 시험판 exe 를 주세요' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path $env:TEMP "memoking-os-e2e\$stamp"
$vault = Join-Path $work 'vault'
$shots = Join-Path $work 'shots'
$files = Join-Path $work 'files'
New-Item -ItemType Directory -Force $vault, $shots, $files | Out-Null
$profileDir = Join-Path $env:APPDATA 'MemoKing-e2e'
if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir }
New-Item -ItemType Directory -Force $profileDir | Out-Null
[IO.File]::WriteAllText((Join-Path $profileDir 'settings.json'), (@{ vaultPath = $vault; tutorialDone = $true } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# 끌어 놓을 파일: 눈에 띄는 색의 사진(화면에서 찾아 누르려고) · 한 쪽짜리 PDF
$png = Join-Path $files '시험 사진.png'
$bmp = New-Object System.Drawing.Bitmap 160, 120
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 255)); $g.Dispose()
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
$pdf = Join-Path $files '시험 문서.pdf'
[IO.File]::WriteAllText($pdf, "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]>>endobj`ntrailer<</Root 1 0 R>>`n%%EOF`n")

$results = New-Object System.Collections.Generic.List[object]
function Add-Result($name, $ok, $detail = '') { $results.Add([pscustomobject]@{ 시험 = $name; 결과 = $(if ($ok) { '통과' } else { '실패' }); 자세히 = $detail }); Write-Host ("{0}  {1}  {2}" -f $(if ($ok) { 'O' } else { 'X' }), $name, $detail) }
function Save-Shot($name, $h) {
  $r = [W]::Rect($h); $w = $r.R - $r.L; $hh = $r.B - $r.T
  $b = New-Object System.Drawing.Bitmap $w, $hh
  [System.Drawing.Graphics]::FromImage($b).CopyFromScreen($r.L, $r.T, 0, 0, $b.Size)
  $b.Save((Join-Path $shots "$name.png")); return $b
}
function Get-TestPids { @(Get-Process memoking -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq (Resolve-Path $Exe).Path } | ForEach-Object { [uint32]$_.Id }) }
function Wait-Until($sec, [scriptblock]$fn) { $t = [DateTime]::Now.AddSeconds($sec); while ([DateTime]::Now -lt $t) { $v = & $fn; if ($v) { return $v }; Start-Sleep -Milliseconds 200 }; return $null }
function Get-VaultText { (Get-ChildItem $vault -Filter *.md -Recurse -ErrorAction SilentlyContinue | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n" }
# 그 창 사진에서 그 색의 덩어리 가운데 (못 찾으면 $null)
function Find-Color($bmp, [scriptblock]$match) {
  $xs = 0; $ys = 0; $n = 0
  for ($y = 0; $y -lt $bmp.Height; $y += 4) { for ($x = 0; $x -lt $bmp.Width; $x += 4) { if (& $match $bmp.GetPixel($x, $y)) { $xs += $x; $ys += $y; $n++ } } }
  if ($n -lt 20) { return $null }; return @([int]($xs / $n), [int]($ys / $n))
}

# 파일 하나를 진짜로 끌어 놓는다: 작은 창(끌기 시작점)에서 OLE 끌기 → 마우스를 목표로 → 놓기. 받은 쪽이 받아들였는지(Copy)도 돌려준다
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
  $form.Add_Shown({ $c = $form.PointToScreen((New-Object System.Drawing.Point 80, 30)); [void][W]::DragLater($c.X, $c.Y, $x, $y, 300) })
  $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 15000; $timer.Add_Tick({ $form.Close() }); $timer.Start()
  [void]$form.ShowDialog(); $timer.Stop(); $form.Dispose()
  return $script:dropEffect
}

$wasRunning = [bool](Get-Process MemoKing -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $installed })
Get-Process memoking -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1
try {
  Start-Process $Exe -ArgumentList '--profile=e2e'
  $list = Wait-Until 30 { $p = Get-TestPids; if ($p) { [W]::Windows($p) | Select-Object -First 1 } }
  if (-not $list) { throw '시험판 목록 창이 뜨지 않았어요' }
  Start-Sleep 3 # 예비 창까지 준비

  # 1) 새 메모에 바탕의 파일을 끌어 놓기 — 첫 시도에 들어가는가 (예전: 첫 놓기가 말없이 사라졌다)
  for ($i = 1; $i -le $Rounds; $i++) {
    $before = [W]::Windows((Get-TestPids))
    Start-Process $Exe -ArgumentList '--profile=e2e', '--new-memo'
    $note = Wait-Until 15 { [W]::Windows((Get-TestPids)) | Where-Object { $before -notcontains $_ } | Select-Object -First 1 }
    if (-not $note) { Add-Result "끌어 놓기 $i 회째" $false '새 메모 창이 뜨지 않음'; continue }
    Start-Sleep 2
    $r = [W]::Rect($note)
    $count = ([regex]::Matches((Get-VaultText), 'attachments/')).Count
    $effect = Invoke-FileDrop $png ([int](($r.L + $r.R) / 2)) ([int]($r.T + ($r.B - $r.T) * 0.6))
    $in = Wait-Until 8 { ([regex]::Matches((Get-VaultText), 'attachments/')).Count -gt $count }
    $shot = Save-Shot "1-drop-$i" $note
    $shot.Dispose()
    Add-Result "끌어 놓기 $i 회째 (첫 시도)" ([bool]$in) "끌기 결과=$effect"
  }

  # 2) 메모 창을 위 막대로 옮기기
  $note = [W]::Windows((Get-TestPids)) | Where-Object { [W]::Title($_) -ne '메모킹' } | Select-Object -Last 1
  if ($note) {
    [void][W]::SetForegroundWindow($note); Start-Sleep -Milliseconds 300
    $r = [W]::Rect($note); $x = [int](($r.L + $r.R) / 2); $y = $r.T + 18
    [W]::Drag($x, $y, $x + 70, $y + 50); Start-Sleep -Milliseconds 400
    $r2 = [W]::Rect($note)
    Add-Result '메모 창 옮기기 (위 막대)' ([Math]::Abs(($r2.L - $r.L) - 70) -le 12 -and [Math]::Abs(($r2.T - $r.T) - 50) -le 12) "옮긴 만큼 ($($r2.L - $r.L), $($r2.T - $r.T))"

    # 3) 사진 보기: 넣은 사진(분홍)을 눌러 열고 → 위 막대로 창 옮기기 → Esc
    $shot = Save-Shot '3-before-photo' $note
    $spot = Find-Color $shot { param($c) $c.R -gt 230 -and $c.G -lt 40 -and $c.B -gt 230 }
    $shot.Dispose()
    if (-not $spot) { Add-Result '사진 보기' $false '메모에서 넣은 사진을 찾지 못함' }
    else {
      $r = [W]::Rect($note); [W]::Click($r.L + $spot[0], $r.T + $spot[1]); Start-Sleep 1
      $shot = Save-Shot '3-photo-open' $note
      $dark = $shot.GetPixel(4, [int]($shot.Height / 2)); $shot.Dispose()
      $open = $dark.R -lt 40 -and $dark.G -lt 40 -and $dark.B -lt 40
      Add-Result '사진 보기 열림' $open "가장자리 색 $($dark.R),$($dark.G),$($dark.B)"
      if ($open) {
        $r = [W]::Rect($note); $x = [int]($r.L + ($r.R - $r.L) * 0.35); $y = $r.T + 14
        [W]::Drag($x, $y, $x - 60, $y + 40); Start-Sleep -Milliseconds 400
        $r2 = [W]::Rect($note)
        Add-Result '사진 보기에서 창 옮기기' ([Math]::Abs(($r2.L - $r.L) + 60) -le 12 -and [Math]::Abs(($r2.T - $r.T) - 40) -le 12) "옮긴 만큼 ($($r2.L - $r.L), $($r2.T - $r.T))"
        [W]::Key(0x1B); Start-Sleep -Milliseconds 600
        $shot = Save-Shot '3-photo-closed' $note; $c = $shot.GetPixel(4, [int]($shot.Height / 2)); $shot.Dispose()
        Add-Result '사진 보기 Esc 로 닫힘' (-not ($c.R -lt 40 -and $c.G -lt 40 -and $c.B -lt 40))
      }
    }

    # 4) PDF 보기: PDF 를 끌어 넣고 → 첫 쪽 썸네일(흰 종이)을 눌러 열고 → 위 막대로 창 옮기기 → Esc
    $before = [W]::Windows((Get-TestPids))
    Start-Process $Exe -ArgumentList '--profile=e2e', '--new-memo'
    $pnote = Wait-Until 15 { [W]::Windows((Get-TestPids)) | Where-Object { $before -notcontains $_ } | Select-Object -First 1 }
    if (-not $pnote) { Add-Result 'PDF 보기' $false '새 메모 창이 뜨지 않음' }
    else {
      Start-Sleep 2
      $r = [W]::Rect($pnote)
      $effect = Invoke-FileDrop $pdf ([int](($r.L + $r.R) / 2)) ([int]($r.T + ($r.B - $r.T) * 0.6))
      $thumb = Wait-Until 20 { (Get-VaultText) -match '!\[[^\]]*\]\([^)]*\.png "pdf ' }
      Add-Result 'PDF 끌어 넣기 → 첫 쪽 썸네일' ([bool]$thumb) "끌기 결과=$effect"
      Start-Sleep 1
      $shot = Save-Shot '4-before-pdf' $pnote
      $spot = Find-Color $shot { param($c) $c.R -ge 254 -and $c.G -ge 254 -and $c.B -ge 254 }
      $shot.Dispose()
      if ($thumb -and $spot) {
        $r = [W]::Rect($pnote); [W]::Click($r.L + $spot[0], $r.T + $spot[1]); Start-Sleep 2
        $shot = Save-Shot '4-pdf-open' $pnote
        $c = $shot.GetPixel([int]($shot.Width / 2), $shot.Height - 6); $shot.Dispose()
        $open = $c.R -lt 60 -and $c.G -lt 60 -and $c.B -lt 60
        Add-Result 'PDF 보기 열림' $open "아래쪽 색 $($c.R),$($c.G),$($c.B)"
        if ($open) {
          $r = [W]::Rect($pnote); $x = [int]($r.L + ($r.R - $r.L) * 0.45); $y = $r.T + 14
          [W]::Drag($x, $y, $x + 50, $y + 40); Start-Sleep -Milliseconds 400
          $r2 = [W]::Rect($pnote)
          Add-Result 'PDF 보기에서 창 옮기기' ([Math]::Abs(($r2.L - $r.L) - 50) -le 12 -and [Math]::Abs(($r2.T - $r.T) - 40) -le 12) "옮긴 만큼 ($($r2.L - $r.L), $($r2.T - $r.T))"
          [W]::Key(0x1B); Start-Sleep -Milliseconds 600
          $shot = Save-Shot '4-pdf-closed' $pnote; $shot.Dispose()
        }
      } elseif ($thumb) { Add-Result 'PDF 보기' $false '메모에서 첫 쪽 썸네일을 찾지 못함' }
    }
  } else { Add-Result '메모 창 옮기기' $false '메모 창을 찾지 못함' }
}
finally {
  Get-Process memoking -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq (Resolve-Path $Exe).Path } | Stop-Process -Force
  if ($wasRunning -and (Test-Path $installed)) { Start-Process $installed }
}

$report = Join-Path $work '결과.txt'
$results | Format-Table -AutoSize | Out-String -Width 200 | Out-File -Encoding utf8 $report
Write-Host ''
Write-Host "결과: $report"
Write-Host "화면 사진: $shots"
if ($results | Where-Object 결과 -eq '실패') { exit 1 }
