# 메모킹 OS 수준 시험 (짧은 판) — 진짜 마우스로 끌어 놓기 · 창 옮기기만 빠르게
#   모든 기능을 거치는 시나리오는 os-scenario.ps1. 공용 도구 · 안전장치는 os-lib.ps1
#   시험하는 동안 마우스 · 키보드를 만지지 않는다
#
#   powershell -ExecutionPolicy Bypass -File scripts\os-e2e.ps1 [-Exe 시험판.exe] [-Rounds 3]
param(
  [string]$Exe = "$env:LOCALAPPDATA\MemoKing-test\memoking.exe",
  [int]$Rounds = 3
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'os-lib.ps1')

Initialize-TestRun $Exe
try {
  Start-TestApp
  $list = Wait-Until 30 { $p = Get-TestPids; if ($p) { [W]::Windows($p) | Select-Object -First 1 } }
  if (-not $list) { throw '시험판 목록 창이 뜨지 않았어요' }
  Start-Sleep 3 # 예비 창까지 준비

  # 새 메모에 바탕의 파일을 끌어 놓기 — 첫 시도에 들어가는가 (예전: 첫 놓기가 말없이 사라졌다)
  for ($i = 1; $i -le $Rounds; $i++) {
    $before = [W]::Windows((Get-TestPids))
    Start-TestApp @('--new-memo')
    $note = Wait-Until 15 { [W]::Windows((Get-TestPids)) | Where-Object { $before -notcontains $_ } | Select-Object -First 1 }
    if (-not $note) { Add-Result "끌어 놓기 $i 회째" $false '새 메모 창이 뜨지 않음'; continue }
    Start-Sleep 2
    $r = [W]::Rect($note)
    $count = ([regex]::Matches((Get-VaultText), 'attachments/')).Count
    $effect = Invoke-FileDrop $script:Png ([int](($r.L + $r.R) / 2)) ([int]($r.T + ($r.B - $r.T) * 0.6))
    $in = Wait-Until 8 { ([regex]::Matches((Get-VaultText), 'attachments/')).Count -gt $count }
    (Save-Shot "drop-$i" $note).Dispose()
    Add-Result "끌어 놓기 $i 회째 (첫 시도)" ([bool]$in) "끌기 결과=$effect"
  }

  # 메모 창을 위 막대로 옮기기
  $note = [W]::Windows((Get-TestPids)) | Where-Object { [W]::Title($_) -ne '메모킹' } | Select-Object -Last 1
  if ($note) {
    [void][W]::SetForegroundWindow($note); Start-Sleep -Milliseconds 300
    $r = [W]::Rect($note); $x = [int](($r.L + $r.R) / 2); $y = $r.T + 18
    [W]::Drag($x, $y, $x + 70, $y + 50); Start-Sleep -Milliseconds 400
    $r2 = [W]::Rect($note)
    Add-Result '메모 창 옮기기 (위 막대)' ([Math]::Abs(($r2.L - $r.L) - 70) -le 12 -and [Math]::Abs(($r2.T - $r.T) - 50) -le 12) "옮긴 만큼 ($($r2.L - $r.L), $($r2.T - $r.T))"
  } else { Add-Result '메모 창 옮기기' $false '메모 창을 찾지 못함' }
}
finally { Stop-TestRun }
Write-Report
if ($script:Results | Where-Object 결과 -eq '실패') { exit 1 }
