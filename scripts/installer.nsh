; 설치 파일(NSIS)에 끼우는 조각 — electron-builder 가 build/installer.nsh 로 읽는다 (scripts/build-dist.mjs 가 조립 폴더에 복사)
;
; 업데이트가 "Failed to uninstall old application files(이전 설치 파일을 지우지 못했어요)" 로 멈추는 것을 막는다:
;   메모킹이 띄운 PowerShell 도우미(알림 모으기 · 클립보드)가 앱이 끝난 뒤에도 남아 설치 폴더의 파일을 붙잡고 있으면 이전 파일을 지울 수 없다.
;   앱도 끝낼 때 도우미를 끄지만(desktop/main.js stopHelpers), 예전 버전이 남긴 것 · 비정상 종료로 남은 것까지 설치 시작 때 정리한다.
;   AI 글 도우미 엔진(llama-server.exe)도 설치 폴더의 DLL 을 붙잡으므로 함께 정리한다.
;   표시: 명령줄에 "app.asar.unpacked" (메모킹 설치 폴더 안의 도우미 파일) 가 든 PowerShell 만 — 다른 PowerShell 은 건드리지 않는다.
!macro mkKillHelpers
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -in 'powershell.exe','llama-server.exe' -and $$_.CommandLine -like '*app.asar.unpacked*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 500
!macroend

!macro customInit
  !insertmacro mkKillHelpers
!macroend

!macro customUnInit
  !insertmacro mkKillHelpers
!macroend
