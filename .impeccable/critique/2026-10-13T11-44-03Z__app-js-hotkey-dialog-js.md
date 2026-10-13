---
target: new desktop UI (hotkey dialog, widget, HUD, hover copy/delete, badges)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/user/MemoKing/app/js/hotkey-dialog.js"
target_fingerprint: "sha256:1d1c4189caa973da1a576f527cf715912a992dfa27e9d47a287486ce25bd4523"
target_path: /home/user/MemoKing/app/js/hotkey-dialog.js
timestamp: 2026-10-13T11-44-03Z
slug: app-js-hotkey-dialog-js
---
Method: dual-agent (A: design review · B: detector + visual evidence)

Target: new desktop UI — memo hotkey dialog, desktop widget, copy HUD, hover copy/delete on content blocks, list card badges.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Widget actions invisible until hover |
| 2 | Match system / real world | 3 | "단축키로 불러오기" said load; default is copy |
| 3 | User control & freedom | 2 | One-click hover ✕ removes whole tables; pinning closes the memo window silently |
| 4 | Consistency & standards | 3 | Widget ✕ = unpin, elsewhere ✕ = close; spaced particles after key labels |
| 5 | Error prevention | 3 | Keys held by other apps could still be saved |
| 6 | Recognition over recall | 2 | 4px "taken" dot with legend only before a choice |
| 7 | Flexibility & efficiency | 3 | Global hotkeys + copy-without-title strong |
| 8 | Aesthetic & minimalist | 3 | Redundant lead line in dialog |
| 9 | Error recovery | 3 | Raw err.message in copy-fail tooltip |
| 10 | Help & documentation | 2 | Discovery only via ⋯ menu |
| **Total** | | **27/40** | Good |

Detector: 9 findings, all in pre-existing note.css rules (pulsing record dot, quote border-left, checkerboard swatch, height transition) — none in new UI; side-tab / stripes are false positives.
Contrast fails: failed/blocked key numbers 3.36:1; widget grip 1.32:1.

Priority issues:
- [P1] Hover ✕ on tables/math deletes in one click → add in-place "…을 지웠어요 · Ctrl+Z 로 되돌리기".
- [P1] Widget ✕ reads as close; actions hidden at idle → unpin glyph, faint idle actions, stronger grip, HUD after pin/unpin.
- [P2] Hotkey slot occupancy hard to read; failed keys savable → persistent legend, distinct failed style, save blocked, owner shown on focus, digit keys.
- [P2] Keyboard: radiogroup already roving via dom.js radioGroups (false positive); widgets not keyboard-reachable (open from memo menu).
- [P3] Copy: rename to "단축키 정하기", particle-free "Ctrl+Alt+3: …", HUD "“제목” 내용을 복사했어요", keycap badge, generic copy-fail text, Ctrl+V tip only first 3 times.
