---
target: 일정 탭 · 다른 캘린더와 잇기
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/home/user/MemoKing/app/js/list-reminders.js"
target_fingerprint: "sha256:ba23fe968bd359743da1178048ff206e14206900230ec73be6d0f7cb13c0d388"
target_path: /home/user/MemoKing/app/js/list-reminders.js
timestamp: 2026-10-17T00-56-46Z
slug: app-js-list-reminders-js
---
# 일정 탭 · 다른 캘린더와 잇기 — 비평 (수정 전 22/40)
Method: dual-agent (A: 디자인 리뷰 · B: 검출기 + 브라우저 측정)
1 상태 3 · 2 현실 일치 2 · 3 통제 1 · 4 일관성 2 · 5 오류 예방 2 · 6 인식 2 · 7 유연성 3 · 8 미니멀 2 · 9 오류 복구 2 · 10 도움말 3
Priority issues:
- [P0] 외부 일정 탭 → 앱 밖 Google 캘린더 "일정을 찾을 수 없습니다" — 고침 (자세히 보기)
- [P1] 다른 캘린더 창 읽기/쓰기 구분 없음 — 고침 (꼬리표 3칸)
- [P1] 목록 보기: 시간 열이 폭 절반, 제목 99px에서 말줄임 없이 잘림 — 남음
- [P2] 칩 색 · 모양 의미(점선이 거의 모든 칩) — 고침 (내 일정 꽉 찬 칩 · 외부 옅은 칩)
- [P2] 월 보기 밀도(칩 38px 폭, 말줄임 없이 잘림, 탭 영역 16px) — 남음
Remaining a11y: 보기 전환 46x28, 칩 16px 높이, 스위치 40x24, 대비는 모두 AA 통과
