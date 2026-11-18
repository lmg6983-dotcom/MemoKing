# 메모킹 시나리오 시험 — 가상 사용자 "지민" 의 하루를 진짜 마우스 · 키보드로 따라 하며 기능을 모두 거친다
#   요소 자리는 화면에 묻고(원격 디버깅 — 개발판만), 누르기 · 치기 · 끌기는 Windows 입력으로 (os-lib.ps1)
#   한 단계가 실패해도 다음 단계로 — 끝에 결과표와 단계마다 화면 사진. 시험하는 동안 마우스 · 키보드를 만지지 않는다
#
#   powershell -ExecutionPolicy Bypass -File scripts\os-scenario.ps1 [-Exe 시험판.exe]
param([string]$Exe = "$env:LOCALAPPDATA\MemoKing-test\memoking.exe")
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'os-lib.ps1')

$script:ShotN = 0
function Save-Screen($name) {
  $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  (Save-ShotRect ('{0:D2}-{1}' -f (++$script:ShotN), $name) $s.Left $s.Top $s.Width $s.Height).Dispose()
}
# 한 단계: 본문이 $true · $false 또는 @(맞음, 자세히) 를 돌려준다. 오류는 실패로 적고 다음 단계로
function Step($name, [scriptblock]$body) {
  try {
    $r = & $body
    if ($r -is [array]) { Add-Result $name ([bool]$r[0]) $r[1] } else { Add-Result $name ([bool]$r) }
  } catch { Add-Result $name $false $_.Exception.Message }
  try { Save-Screen ($name -replace '[\\/:*?"<>|]', '') } catch {}
}
function Wait-Js($page, $expr, $sec = 6) { [bool](Wait-Until $sec { Test-Js $page $expr }) }
function Esc { if ($script:Note) { Show-Page $script:Note }; [W]::Keys(0x1B); Start-Sleep -Milliseconds 500 }
function Open-Menu($page) { Click-El $page '#menu-btn'; if (-not (Wait-Js $page "!document.getElementById('menu').hidden" 3)) { throw '메뉴가 열리지 않음' } }

Initialize-TestRun $Exe
$script:Note = $null
try {
  Start-TestApp
  $list = Wait-Until 30 { Find-Page $script:ListUrl }
  Step '시작: 목록 창이 뜨고 화면에 연결됨' { [bool]$list }
  if (-not $list) { throw '목록 창(원격 디버깅)에 연결하지 못했어요 — 최신 시험판인지 확인해 주세요' }
  Start-Sleep 2
  # 새로 만든 설정이라 "vX 으로 업데이트했어요" 안내가 뜬다 — 사람처럼 확인을 눌러 닫고 시작
  if (Wait-Js $list "Boolean(document.querySelector('dialog[open]'))" 3) {
    Step '처음 안내 창 닫기 (확인)' {
      Click-El $list 'dialog[open] button:last-of-type'
      Wait-Js $list "!document.querySelector('dialog[open]')" 3
    }
  }

  # ---------- 아침: 새 메모에 장보기 목록 ----------
  Step '목록 창 [+] › 글 메모 로 새 메모' {
    Click-El $list '#fab' # + 는 위로 위성 단추(음성 · 손 · 글 메모)를 펼친다
    if (-not (Wait-Js $list "Boolean(document.querySelector('[data-new=""text""]')?.offsetParent)" 3)) { throw '+ 메뉴가 펼쳐지지 않음' }
    Start-Sleep -Milliseconds 300
    Click-El $list '[data-new="text"]'
    $script:Note = Wait-Until 15 { Find-Page 'note\.html' }
    [bool]$script:Note
  }
  $n = $script:Note
  if (-not $n) { throw '메모 창이 없어 시나리오를 이어 갈 수 없어요' }
  Start-Sleep 1

  Step '제목과 체크리스트 쓰기 (한글 그대로)' {
    Click-El $n '.mk-doc'
    [W]::Type("장보기 목록`n")
    [W]::Keys(0x11, 0x10, 0x39) # 체크리스트 Ctrl+Shift+9 (좁은 창에서는 서식 막대 단추가 ≫ 안에 접힌다)
    [W]::Type("우유`n계란")
    Wait-Js $n "document.querySelectorAll('.mk-doc li').length >= 2 && document.querySelector('.mk-doc').textContent.includes('계란')"
  }
  Step '굵게 (Shift+Home → Ctrl+B)' {
    [W]::Keys(0x10, 0x24); [W]::Keys(0x11, 0x42)
    Wait-Js $n "Boolean(document.querySelector('.mk-doc strong'))"
  }
  Step '태그 달기 (#장보기)' {
    [W]::Keys(0x23); [W]::Type("`n`n#장보기 ")
    Wait-Js $n "Boolean(document.querySelector('.mk-doc .mk-tag'))"
  }
  Step '체크 표시 (첫 항목 누르기)' {
    Click-El $n '.mk-doc li' 0.02 0.5
    Wait-Js $n "document.querySelector('.mk-doc li')?.getAttribute('data-checked') === 'true'" 3
  }
  Step '메모 색 바꾸기 (메뉴 › 색)' {
    $before = Invoke-Js $n 'document.body.dataset.color'
    Open-Menu $n
    Click-El $n '#swatches button:nth-of-type(3)'
    $after = Invoke-Js $n 'document.body.dataset.color'
    Esc
    @(($after -and $after -ne $before), "$before → $after")
  }
  Step '저장됨 (메모 폴더 파일에 글)' { [bool](Wait-Until 5 { (Get-VaultText) -match '계란' }) }

  # ---------- 점심: 사진 · 문서 넣기 ----------
  Step '바탕의 사진을 끌어 넣기 (첫 시도)' {
    $s = Get-Spot $n '.mk-doc' 0.5 0.85
    $effect = Invoke-FileDrop $script:Png $s.x $s.y
    @((Wait-Js $n "Boolean(document.querySelector('.mk-doc img.mk-image:not(.mk-pdf-thumb)'))" 8), "끌기 결과=$effect")
  }
  Step '사진 보기: 열기' {
    Click-El $n '.mk-doc img.mk-image:not(.mk-pdf-thumb)'
    Wait-Js $n "Boolean(document.querySelector('.mk-album-view'))"
  }
  Step '사진 보기: 위 막대로 창 옮기기' { Test-WindowDrag $n '.mk-album-head' -60 40 0.02 0.5 } # 왼쪽 끝 빈 곳 (좁은 창은 단추가 막대를 채운다)
  Step '사진 보기: Esc 로 닫기' { Esc; Wait-Js $n "!document.querySelector('.mk-album-view')" 3 }

  Step 'PDF 를 끌어 넣기 → 첫 쪽 썸네일' {
    $s = Get-Spot $n '.mk-doc' 0.5 0.9
    $effect = Invoke-FileDrop $script:Pdf $s.x $s.y
    @((Wait-Js $n "Boolean(document.querySelector('.mk-doc img.mk-pdf-thumb'))" 25), "끌기 결과=$effect")
  }
  Step 'PDF 보기: 열기 · 왼쪽 도구 줄' {
    Click-El $n '.mk-doc img.mk-pdf-thumb'
    Wait-Js $n "Boolean(document.querySelector('.mk-pdf-view .mk-pdf-rail')) && Boolean(document.querySelector('.mk-pdf-page'))" 10
  }
  Step 'PDF 보기: 위 막대로 창 옮기기' { Test-WindowDrag $n '.mk-pdf-heading' 50 40 }
  Step 'PDF 보기: 닫기는 오른쪽 끝' {
    Test-Js $n "(() => { const c = document.querySelector('.mk-pdf-close').getBoundingClientRect(); return c.right > innerWidth - 20; })()"
  }
  Step 'PDF 보기: 펜으로 주석 → 고르기로 돌아오면 저장' {
    Click-El $n '.mk-pdf-rail .mk-pdf-tool:nth-child(2)'
    if (-not (Wait-Js $n "document.querySelector('.mk-pdf-view').dataset.mode === 'ink'" 3)) { throw '그리기로 바뀌지 않음' }
    $s = Get-Spot $n '.mk-pdf-page' 0.3 0.4
    [W]::Drag($s.x, $s.y, $s.x + 90, $s.y + 30)
    $drawn = Wait-Js $n "document.querySelectorAll('.mk-pdf-ink path').length > 0" 3
    Click-El $n '.mk-pdf-rail .mk-pdf-tool:nth-child(1)'
    @(($drawn -and (Wait-Js $n "document.querySelector('.mk-pdf-view').dataset.mode === 'view'" 5)), $(if ($drawn) { '그린 획 있음' } else { '획이 그려지지 않음' }))
  }
  Step 'PDF 보기: Esc 로 닫기' { Start-Sleep 1; Esc; Wait-Js $n "!document.querySelector('.mk-pdf-view')" 5 }

  # ---------- 오후: 그리기 · 표 · 찾기 ----------
  Step '손 메모: 그려서 넣기 (Ctrl+Shift+D)' {
    Click-El $n '#editor' 0.5 0.9 # 보이는 글 칸 아래쪽 (긴 메모는 .mk-doc 아래 끝이 창 밖)
    [W]::Keys(0x11, 0x10, 0x44)
    if (-not (Wait-Js $n "Boolean(document.querySelector('.ink-sheet'))" 4)) { throw '그리기 화면이 열리지 않음' }
    $s = Get-Spot $n '.ink-scroll' 0.4 0.4
    [W]::Drag($s.x, $s.y, $s.x + 80, $s.y + 50)
    Click-El $n '.ink-sheet .ink-done'
    Wait-Js $n "Boolean(document.querySelector('.mk-doc .mk-ink'))" 6
  }
  Step '표 넣기 (+ › 표)' {
    Click-El $n '#add-btn'
    Click-El $n '[data-add="table"]'
    Wait-Js $n "Boolean(document.querySelector('.mk-doc table'))" 4
  }
  Step '찾기 열고 닫기 (Ctrl+F → Esc)' {
    [W]::Keys(0x11, 0x46)
    $open = Wait-Js $n "document.activeElement?.tagName === 'INPUT' && !document.activeElement.closest('.mk-doc')" 3
    [W]::Type('우유'); Start-Sleep -Milliseconds 300
    Esc
    $open
  }
  Step '이전 버전 보기' {
    Open-Menu $n
    Click-El $n '#versions-btn'
    $ok = Wait-Js $n "Boolean(document.getElementById('versions-close')?.offsetParent)" 4
    if ($ok) { Click-El $n '#versions-close' }
    $ok
  }
  Step '늘 위에 두기 (왕관) 켜고 끄기' {
    $a = Invoke-Js $n "document.getElementById('top-btn').outerHTML"
    Click-El $n '#top-btn'; Start-Sleep -Milliseconds 400
    $b = Invoke-Js $n "document.getElementById('top-btn').outerHTML"
    Click-El $n '#top-btn'
    @(($a -ne $b), $(if ($a -ne $b) { '단추 상태가 바뀜' } else { '눌러도 그대로' }))
  }
  Step '메모 창: 위 막대로 옮기기' { Test-WindowDrag $n '.bar' 70 50 }

  # ---------- 저녁: 다른 창들 ----------
  Step 'PDF로 저장 창: 열고 옮기고 닫기' {
    Open-Menu $n
    Click-El $n '#pdf-btn'
    $p = Wait-Until 10 { Find-Page 'pdf\.html' }
    if (-not $p) { throw 'PDF로 저장 창이 뜨지 않음' }
    Start-Sleep 1
    $m = Test-WindowDrag $p '.options h1' 60 40
    Click-El $p '#cancel'
    # 취소하면 창이 닫혀야 한다 (예전: window.close() 를 받는 곳이 없어 화면만 사라진 흰 창이 남았다 — shim.js)
    #   화면 목록에서 사라져도 Windows 창이 남을 수 있어 창 제목으로 본다
    $closed = [bool](Wait-Until 5 { -not ([W]::Windows((Get-TestPids)) | Where-Object { [W]::Title($_) -eq 'PDF로 저장' }) })
    @(($m[0] -and $closed), "$($m[1]) · 취소로 닫힘=$closed")
  }
  Step '단축키 목록: 메뉴에서 열고 닫기' {
    Open-Menu $n
    if (-not (Test-Js $n "Boolean(document.getElementById('shortcuts-btn')?.offsetParent)")) { Click-El $n '#menu-more-btn' }
    Click-El $n '#shortcuts-btn'
    if (-not (Wait-Js $n "Boolean(document.querySelector('.shortcut-sheet[open]'))" 4)) { throw '단축키 목록이 뜨지 않음' }
    Click-El $n '.shortcut-sheet[open] .dialog-x'
    Wait-Js $n "!document.querySelector('.shortcut-sheet[open]')" 3
  }
  Step '메모 닫고 목록에서 찾아 다시 열기' {
    Click-El $n '#close-btn'
    if (-not (Wait-Until 5 { -not (Find-Page 'note\.html') })) { throw '메모 창이 닫히지 않음' }
    Click-El $list '#search'
    [W]::Type('장보기'); Start-Sleep 1
    Click-El $list '.card'
    $script:Note = Wait-Until 10 { Find-Page 'note\.html' }
    [bool]$script:Note
  }
  $n = $script:Note
  Step '다시 연 메모에 글 · 사진 · PDF · 손 메모가 그대로' {
    $n -and (Wait-Js $n "(() => { const d = document.querySelector('.mk-doc'); return d && d.textContent.includes('계란') && d.querySelector('img.mk-image:not(.mk-pdf-thumb)') && d.querySelector('img.mk-pdf-thumb') && d.querySelector('.mk-ink'); })()" 8)
  }
  Step '휴지통으로 (메뉴 › 삭제)' {
    Open-Menu $n
    Click-El $n '#delete-btn'
    if (Test-Js $n "Boolean(document.getElementById('confirm-ok')?.offsetParent)") { Click-El $n '#confirm-ok' }
    Wait-Until 6 { -not (Find-Page 'note\.html') }
  }
}
catch { Add-Result '시나리오 멈춤' $false $_.Exception.Message }
finally { Stop-TestRun }
Write-Report
if ($script:Results | Where-Object 결과 -eq '실패') { exit 1 }
