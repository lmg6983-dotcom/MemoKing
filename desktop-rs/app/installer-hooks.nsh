; 설치 파일(Tauri NSIS)에 끼우는 조각 — tauri.conf.json bundle.windows.nsis.installerHooks
;
; 메모킹 1.0 으로 갈아탈 때: Electron 판(0.87 까지) · Rust 베타("MemoKing Beta")를 지우고 이 판으로.
;   메모 폴더 · 설정(%APPDATA%\MemoKing)은 그대로 둔다 — 세 판이 같은 것을 쓴다.
;   Electron 판의 자동 업데이트(electron-updater)는 이 설치 파일을 "--updated /S --force-run" 으로 띄운다 (조용히 설치 → 다시 켜기)
;   지우는 것은 파일을 깔기 전에: 예전 판의 지우개가 끝난 뒤 깔아야, 지우개가 같은 이름의 것(베타 · 이 판의 MemoKing.exe ·
;   바로가기 · 레지스트리 값)을 새로 깐 뒤에 건드리지 않는다 (Electron 판 바로가기 이름은 메모킹.lnk)
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

; 바로가기가 Electron 판 자리(지운 exe)를 가리키면 이 판으로 — 업데이트(/UPDATE)로 깔 때 Tauri 는 바로가기를 건드리지 않아
;   없는 exe 를 가리킨 채 남았고, 시작 메뉴 아이콘과 Windows 알림(같은 앱 이름이라 이 바로가기의 아이콘을 쓴다) 아이콘이 깨졌다
!macro MkFixShortcut lnk
  !insertmacro IsShortcutTarget "${lnk}" "$LOCALAPPDATA\Programs\MemoKing\MemoKing.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "${lnk}" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "${lnk}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MkFixShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro MkFixShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
  StrCmp $mkAutoStart "on" 0 +2
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MemoKing" '"$INSTDIR\MemoKing.exe" --hidden'
  ; Electron 판의 자동 업데이트가 띄웠으면 다 깔고 바로 켠다 (그쪽은 앱을 끄고 이 설치 파일을 띄운다)
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $0
  IfErrors +2 0
    Exec '"$INSTDIR\MemoKing.exe"'
  ; 게이지를 끝까지 — 업데이트(자동 업데이트는 /P: 진행 창만 띄우고 끝나면 바로 닫는다)는 마지막 칸을 그리기 전에 창이 닫혀
  ;   늘 덜 찬 채 끝나 보였다. 다 깔았으니 채우고 잠깐 보여 준 뒤 닫는다 (1004: 설치 진행 막대, 0x0402: PBM_SETPOS, 범위 0~30000)
  ${IfNot} ${Silent}
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $0 1004
    SendMessage $0 0x0402 30000 0
    Sleep 400
  ${EndIf}
!macroend

; 지울 때: 메모킹이 켤 때마다 적던 레지스트리도 — 탐색기 오른쪽 클릭 › "메모킹에 저장" 메뉴 (desktop-rs/app/src/shell_menu.rs) · 알림
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\MemoKing.Save"
  ; 알림 누르기(memoking: 주소) · 1.5.1 이 적던 알림 이름 · 아이콘 (desktop-rs/app/src/reminders.rs register)
  DeleteRegKey HKCU "Software\Classes\memoking"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.memoking.desktop"
!macroend
