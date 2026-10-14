---
target: 데스크탑 단축키 정하기 대화상자 (스크린샷)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/home/user/MemoKing/app/js/hotkey-dialog.js"
target_fingerprint: "sha256:1d1c4189caa973da1a576f527cf715912a992dfa27e9d47a287486ce25bd4523"
target_path: /home/user/MemoKing/app/js/hotkey-dialog.js
timestamp: 2026-10-14T03-48-04Z
slug: app-js-hotkey-dialog-js
---
Method: dual-agent (A: design review + clarify lens · B: detector + audit)

Target: 데스크탑 "단축키 정하기" 대화상자 (사용자 스크린샷 기준), 1차 수정 이후 재평가.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | 저장 실패 후 hint 갱신 안 됨 |
| 2 | Match system / real world | 3 | "바로 Ctrl+V"가 자동 붙여넣기로 읽힘 |
| 3 | User control & freedom | 3 | 단축키 풀기 즉시 저장·닫힘 |
| 4 | Consistency & standards | 2 | radio인데 방향키 없음·탭 9번, 토글이 checkbox |
| 5 | Error prevention | 2 | 복사+띄우기 동시 켜기 가능 → 붙여넣기 실패; 둘 다 끄기 허용 후 오류 |
| 6 | Recognition over recall | 2 | 내 키에도 '다른 메모' 점; 점선 상태 1.25:1로 안 보임 |
| 7 | Flexibility & efficiency | 3 | 숫자키는 키 줄 포커스일 때만 |
| 8 | Aesthetic & minimalist | 3 | 범례 상시 노출, 제목·요약 중복 |
| 9 | Error recovery | 3 | 실패 키 표시 안 남음 |
| 10 | Help & documentation | 3 | 잠긴 메모 동작 미안내 |
| **Total** | | **27/40** | Good |

Detector: 3 findings, 모두 기존 note.css(녹음 점멸 2, 투명 체커보드 1), 대화상자 무관·오탐.
Contrast fails: 선택 키 노란 테두리 1.51:1(라이트), 선택 채움 1.09:1, 점선 "쓸 수 없음" 테두리 1.25:1, 켜진 토글 트랙 1.51:1(라이트).

Priority issues:
- [P0] 복사+띄우기 동시 켜면 revealNote가 포커스를 가져가 Ctrl+V가 메모 창으로 감 (main.js:166-167) → 3단 세그먼트 또는 showInactive.
- [P1] 내 메모 키에도 taken 점 (hotkey-dialog.js:31) → Boolean(s.title) && !s.mine.
- [P1] 둘 다 끄기 허용 후 빨간 오류 (:89-93) → 상태 자체 제거.
- [P2] 상태 표시 대비 부족: 선택 1.51, 점선 1.25 → 굵은 테두리/진한 점선/사선.
- [P2] radiogroup 키보드·SR: roving tabindex, 방향키, aria-live hint, role=switch.
- [P3] 실패 후 paintNote 미호출, 범례 상시 노출, 카피 다듬기.
