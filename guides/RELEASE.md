# 배포와 자동 업데이트

[← README](../README.md)

## 자동 업데이트 배포

소스와 설치 파일 모두 이 공개 저장소(**`lmg6983-dotcom/MemoKing`**)에 있어요. 앱은 이 저장소의 Release 를 토큰 없이 읽고, 올리기는 Actions 의 기본 토큰(`github.token`)으로 해서 따로 만들 토큰이 없어요.

1.0 부터 PC 정식판은 **Rust + Tauri 판**(`desktop-rs/`)이에요. Electron 판(0.87 까지)은 더 만들지 않아요.

```
Actions › Release (PC) › Run workflow   (.github/workflows/release-rs.yml, windows-latest)
      │  ffmpeg 빌드 → tauri build (Google 연결 정보 · 업데이트 서명)
      ▼
Release v<버전> (최신): MemoKing-Setup-<버전>.exe · MemoKing-Setup.exe · latest-tauri.json · latest.yml
      ▲  latest-tauri.json — Rust 판 (tauri-plugin-updater, 서명이 맞을 때만 설치, services.rs)
      ▲  latest.yml        — Electron 판 0.87 (electron-updater) → 이 설치 파일로 갈아탄다
      ▲  사전 배포 desktop-rs 의 latest-tauri.json 도 같은 것으로 — Rust 베타도 갈아탄다
```

- 최신 설치 파일: `https://github.com/lmg6983-dotcom/MemoKing/releases/latest/download/MemoKing-Setup.exe`
- 버전: `desktop-rs/Cargo.toml` 의 `workspace.package.version` 과 `desktop-rs/app/tauri.conf.json` 의 `version` 을 함께 올리고, README 이력 표에 같은 버전 줄을 써요 (Release 본문 · 앱의 바뀐 점 안내가 그 줄을 읽어요). 같은 버전이면 업데이트로 알리지 않아요.
- 휴대폰: `.github/workflows/android.yml` 이 main 에서 APK 를 만들면 사전 배포 `android` 에 `MemoKing-android.apk` · `android-latest.json` 을 올리고, 앱은 그것을 봐요.
- Secrets: `MEMOKING_GOOGLE_CLIENT_ID` · `MEMOKING_GOOGLE_CLIENT_SECRET` (Google 로그인 연결 정보) · `TAURI_SIGNING_PRIVATE_KEY` (업데이트 서명)
- AI 엔진(llama-server)은 설치 파일에 넣지 않아요. AI를 처음 쓸 때 앱이 llama.cpp 릴리스에서 받아 설정 폴더 `ai\engine` 에 둬요 (`desktop-rs/app/src/ai.rs` 의 `LLAMA_TAG`). 받아쓰기 엔진은 실행 파일 안에 있어요.
- AI 비서 연결(MCP)은 Rust 판에 없어요. Gemini 같은 AI 는 Google Drive 의 메모킹 동기화 폴더를 직접 읽고 써요.

**Electron 판 · Rust 베타에서 갈아타기** (`desktop-rs/app/installer-hooks.nsh`)

- 설치 파일이 파일을 깔기 전에 Electron 판(`%LOCALAPPDATA%\Programs\MemoKing`)과 Rust 베타(`%LOCALAPPDATA%\MemoKing Beta`)를 조용히 지워요. 바로가기 이름이 같아, 나중에 지우면 새 바로가기가 지워지기 때문이에요.
- 메모 폴더와 설정(`%APPDATA%\MemoKing`)은 그대로예요. 세 판이 같은 것을 써요.
- 자동 시작을 켜 두었으면 새 판의 자동 시작으로 옮겨요.
- Electron 판의 자동 업데이트는 설치 파일을 `--updated /S --force-run` 으로 띄워요. `--force-run` 이 있으면 다 깔고 바로 켜요.
- Electron 판 코드와 배포(`release.yml`)는 1.0 에서 지웠어요. 남은 것은 태그 `electron-final` 에 있어요.

**자동 업데이트 서명**

- 공개 열쇠는 `desktop-rs/app/tauri.conf.json` 의 `plugins.updater.pubkey` 에 있어요. 앱은 이 열쇠로 서명이 맞는 설치 파일만 설치해요.
- 개인 열쇠는 저장소 Settings › Secrets and variables › Actions › **Secrets** 의 `TAURI_SIGNING_PRIVATE_KEY` 에 넣어요 (비밀번호 없음). 열쇠 파일은 저장소 밖에 따로 보관해요.
- 열쇠를 바꾸려면 `npx @tauri-apps/cli@2.12.5 signer generate -w memoking.key` 로 새로 만들고 공개 열쇠와 Secret 을 함께 바꿔요. 이미 설치한 앱은 새 열쇠로 서명한 버전을 설치하지 못해 한 번 직접 다시 설치해야 해요.

서명 열쇠가 없어도 워크플로는 돌아요. 그때는 설치 파일만 올라가고 `latest-tauri.json` 은 없어서 자동 업데이트가 되지 않아요.

### 옛 배포 저장소(memoking-releases)

v0.75.3 까지는 설치 파일을 따로 둔 공개 저장소 `memoking-releases` 에 올렸어요. v0.76.0 을 양쪽에 올려 옛 앱이 이 저장소로 넘어오게 한 뒤 그 저장소는 지웠어요. 그래서 v0.76.0 으로 업데이트하지 않은 채 남은 옛 앱(PC v0.75.3 · 휴대폰 0.53.x 까지)은 새 버전을 찾지 못해요 — 위 최신 설치 파일 링크로 한 번 다시 설치하면 돼요 (메모는 그대로). Secret `MEMOKING_RELEASES_TOKEN` 은 이제 쓰지 않으니 지워도 돼요.

**자주 나는 문제**

| 증상 | 까닭 · 해결 |
|---|---|
| 업데이트 정보를 찾지 못함 (latest-tauri.json 404) | Release 가 없거나 **초안(draft)** · 사전 배포(prerelease) 로 올라감 → Release 를 정식(Latest)으로 |
| Actions 의 올리기 단계 403 | 저장소 Settings › Actions › General › Workflow permissions 가 "Read and write" 인지 (워크플로는 `contents: write` 를 달라고 함) |
| 업데이트 파일 없이 설치 파일만 올라감 | Secret `TAURI_SIGNING_PRIVATE_KEY` 가 없음 (위 자동 업데이트 서명) |
| 같은 버전이라 업데이트로 알리지 않음 | `Cargo.toml` · `tauri.conf.json` 의 버전을 올림 |

**코드 서명 (SignPath Foundation — 승인 뒤)**

오픈소스 프로젝트는 [SignPath Foundation](https://signpath.org) 에서 무료로 코드 서명을 받을 수 있어요. 1.0 Rust 설치 파일은 아직 서명 없이 배포해요. 승인을 받으면 `release-rs.yml` 의 빌드 뒤에 서명 단계(`signpath/github-action-submit-signing-request`)를 넣고, 서명본으로 `latest-tauri.json` 의 서명 · `latest.yml` 의 sha512 를 다시 만들어요 (서명하면 파일이 바뀌어요).

- Electron 판 0.87 의 자동 업데이트(electron-updater)는 게시자 이름을 넣지 않고 빌드해서 새 설치 파일의 서명을 검사하지 않아요 — 서명 없는 Rust 설치 파일로도 갈아타요.
- SignPath Foundation 은 README 에 코드 서명 정책을 두라고 해요 → README 의 "코드 서명 정책"
- 없을 때: 처음 설치 · 실행 때 SmartScreen "Windows의 PC 보호" (추가 정보 › 실행)
- 백신 오탐: 서명 없는 새 설치 파일 · PowerShell 도우미를 쓰는 앱은 오탐이 날 수 있음 → 같은 파일로 Microsoft Security Intelligence 에 오탐 신고
