@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo 메모킹을 실행합니다. 잠시 후 이 창은 자동으로 닫힙니다.
echo (메모킹은 작업표시줄 오른쪽 아래 알림 영역에 상주합니다)
call npm run launch > nul
