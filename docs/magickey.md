# ✦ 메모킹 × MagicKey · 🏢 MagicOPMS

매직키는 따로 설치하는 [MagicKey](https://github.com/lmg6983-dotcom/MagicKey) 앱으로, OPMS 검색은 [MagicOPMS](https://github.com/lmg6983-dotcom/MagicOPMS) 앱으로 옮겨 가요.
세 앱은 따로 돌아가고, **명령줄 인자**와 **읽기만 하는 파일**로만 이야기해요. 메모 파일을 쓰는 건 메모킹뿐이에요.

## 🔌 메모킹이 지키는 약속

| 누가 | 무엇 | 어떻게 |
|---|---|---|
| MagicKey → 메모킹 | 메모 열기 | `MemoKing.exe --open-memo=<id>` |
| MagicKey · MagicOPMS → 메모킹 | 새 메모 | `MemoKing.exe --new-memo-file=%TEMP%\magickey-*.txt [--open-new] [--remind]` (0.77.0~) |
| MagicKey → 메모킹 | "여기 있어요" | `%APPDATA%\MemoKing\magickey.json` 의 `exe` 가 있고 그 `pid` 가 켜져 있으면 메모킹은 매직키 단축키를 잡지 않아요. MagicKey 를 끄면 1분 안에 다시 잡아요 (0.77.0~) |
| MagicKey · MagicOPMS → 메모킹 설정 | 읽기만 | `settings.json` 의 `vaultPath` · `appVersion`(0.77.1~, 켤 때마다) · `seenVersion` · `shortcuts.magic` · `magic` · `opms` · `opmsShapes` |
| MagicOPMS → 메모킹 기록 | 읽기만 | `opms-files.json` (받은 전자포대 기록 — 같은 서류를 두 번 받지 않게) |

- `--new-memo-file` 은 **임시 폴더 바로 아래의 1MB 이하 `magickey-*.txt`** 만 받고, 메모를 저장한 뒤에야 지워요.
- `--remind` 가 있으면 첫 줄의 첫 날짜(`remindFromText`)로 알림을 맞춰요.
- 이 약속을 바꾸면 MagicKey 의 [docs/memoking.md](https://github.com/lmg6983-dotcom/MagicKey/blob/main/docs/memoking.md) 도 함께 고쳐요.

## 📦 릴리스 순서

MagicKey · MagicOPMS 를 먼저, 메모킹 0.77.0 을 그다음에 내요. 메모킹은 자동 업데이트로 바로 퍼지지만,
MagicKey 가 없는 사람은 지금처럼 메모킹 매직키를 그대로 써요. 매직키 · OPMS 코드는 몇 버전 뒤에 걷어내요.
