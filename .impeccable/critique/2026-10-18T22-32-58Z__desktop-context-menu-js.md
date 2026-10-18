---
target: PC 오른쪽 클릭 메뉴 · 마우스 올림 단추
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/user/MemoKing/desktop/context-menu.js"
target_fingerprint: "sha256:f2ff481f2ccdef3b866b14e25b3d556d8a6f899cfeefd4ccac0ba574bdbc663f"
target_path: /home/user/MemoKing/desktop/context-menu.js
timestamp: 2026-10-18T22-32-58Z
slug: desktop-context-menu-js
---
Method: dual-agent (A: design review · B: detector + CSS measurement)
Target: PC 오른쪽 클릭 메뉴 · 마우스 올림 단추 (v0.45.0)

Design Health: 26/40 (Nielsen 1:3 2:3 3:3 4:2 5:2 6:2 7:3 8:3 9:3 10:2)
Detector: 5 findings, all out of scope (pulsing-dot ×2 recording, marquee ×2 sync scan, stripes ×1) — likely false positives; runtime-created buttons and native menus not visible to static scan.

Priority issues
- [P1] 내용(그림·파일·표·음성·링크 카드) 오른쪽 클릭이 마우스 올림 단추와 다른 동작 목록 — 지우기·열기·공유 없음, 단추는 키보드로 닿지 않음 (context-menu.js, block-move.js HOVER_TARGET, delete-button.js:118)
- [P1] 내용 × 가 mousedown 순간 지움 · 마우스로 누를 되돌리기 없음 · 안내가 Ctrl 만 눌러도 사라짐 (delete-button.js:255, :58)
- [P2] 단추 묶음 자리·아이콘 뜻이 화면마다 다름 (카드 오른쪽 아래 · 알림 보관함 오른쪽 위, × = 지우기), 알림 보관함 오른쪽 클릭 없음
- [P2] 메뉴 키·Shift+F10 카드 메뉴가 포인터 자리에, 카드 포커스로 단추 묶음이 안 보임, 카드마다 Tab 4번
- [P3] 알림 보관함 복사 피드백 없음, "이전 버전" → "이전 버전…", 탭 메뉴 빈약, 트레이 "최근 메모" 흉내 머리말

Measurements (B): mk-delete-btn 24px / hit 38×44 / × contrast now ≥4.5 (#c4282e); mk-copy… 24px / hit 36×40; card-actions 28px (v0.45) no hit expansion; noti-actions 28px.
