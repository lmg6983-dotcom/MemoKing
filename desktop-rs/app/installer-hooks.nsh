; 설치 파일(Tauri NSIS)에 끼우는 조각 — tauri.conf.json bundle.windows.nsis.installerHooks
;
; 메모킹 1.0 으로 갈아탈 때: Electron 판(0.87 까지) · Rust 베타("MemoKing Beta")를 지우고 이 판으로.
;   메모 폴더 · 설정(%APPDATA%\MemoKing)은 그대로 둔다 — 세 판이 같은 것을 쓴다.
;   Electron 판의 자동 업데이트(electron-updater)는 이 설치 파일을 "--updated /S --force-run" 으로 띄운다 (조용히 설치 → 다시 켜기)
;   지우는 것은 파일을 깔기 전에: Electron 판 바로가기 이름(MemoKing.lnk)이 이 판과 같아, 나중에 지우면 새 바로가기가 지워진다
;   자동 시작을 켜 두었으면 이 판의 자동 시작으로 옮긴다 (tauri-plugin-autostart 와 같은 값: 이름 MemoKing, "<exe>" --hidden)

Var mkAutoStart

!macro NSIS_HOOK_PREINSTALL
  StrCpy $mkAutoStart ""
  ; Electron 판 (electron-builder 사용자별 설치: %LOCALAPPDATA%\Programs\MemoKing)
  IfFileExists "$LOCALAPPDATA\Programs\MemoKing\Uninstall MemoKing.exe" 0 mk_no_electron
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.memoking.desktop"
    StrCmp $0 "" +2
      StrCpy $mkAutoStart "on"
    ; _?= : 지우개가 임시 폴더로 옮겨 가 바로 끝나지 않게 (끝날 때까지 기다린다)
    ExecWait '"$LOCALAPPDATA\Programs\MemoKing\Uninstall MemoKing.exe" /S /currentuser _?=$LOCALAPPDATA\Programs\MemoKing'
    RMDir /r "$LOCALAPPDATA\Programs\MemoKing"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.memoking.desktop"
  mk_no_electron:
  ; Rust 베타 (Tauri 사용자별 설치: %LOCALAPPDATA%\MemoKing Beta)
  IfFileExists "$LOCALAPPDATA\MemoKing Beta\uninstall.exe" 0 mk_no_beta
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MemoKing Beta"
    StrCmp $0 "" +2
      StrCpy $mkAutoStart "on"
    ExecWait '"$LOCALAPPDATA\MemoKing Beta\uninstall.exe" /S _?=$LOCALAPPDATA\MemoKing Beta'
    RMDir /r "$LOCALAPPDATA\MemoKing Beta"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MemoKing Beta"
  mk_no_beta:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCmp $mkAutoStart "on" 0 +2
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MemoKing" '"$INSTDIR\MemoKing.exe" --hidden'
  ; Electron 판의 자동 업데이트가 띄웠으면 다 깔고 바로 켠다 (그쪽은 앱을 끄고 이 설치 파일을 띄운다)
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $0
  IfErrors +2 0
    Exec '"$INSTDIR\MemoKing.exe"'
!macroend
