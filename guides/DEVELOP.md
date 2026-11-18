# 개발 안내

[← README](../README.md)

## 개발용 실행

PC 판은 Rust + Tauri 2 (`desktop-rs/`). 필요한 것: [Rust](https://rustup.rs) (stable), Windows 10/11 (WebView2). 화면 단위 테스트 · 라이브러리 묶기 · 안드로이드 미리보기에는 [Node.js](https://nodejs.org) 22 이상.

```sh
cd desktop-rs
cargo run
```

Electron 판(0.87 까지)은 1.0 에서 지웠어요. 코드는 태그 `electron-final` 에 있어요.

## 명령

| 명령 | 설명 |
|---|---|
| `cd desktop-rs && cargo run` | 앱 실행 (화면은 `app/` 을 그대로 읽는다) |
| `cd desktop-rs && cargo run -- --smoke` | 앱 안 자동 점검 (CI 의 `desktop-rs.yml` 과 같은 것, 결과를 찍고 끝남) |
| `cd desktop-rs && cargo test --workspace` | Rust 단위 테스트 · JS 와 맞춘 답(parity) 비교 |
| `node desktop-rs/parity/gen.mjs` | 공용 JS(`app/js/core`)의 답을 다시 만들기 → `desktop-rs/core/tests/fixtures` (시간대 서울: `TZ=Asia/Seoul`) |
| `bash desktop-rs/scripts/build-ffmpeg-min.sh` | HEVC 영상 변환 · 첫 장면용 작은 ffmpeg.exe → `desktop-rs/vendor/ffmpeg/` (mingw-w64 · nasm) |
| `cd desktop-rs/app && npx @tauri-apps/cli@2.12.5 build` | 설치 파일 → `desktop-rs/target/release/bundle/nsis/` (배포는 [배포 안내](RELEASE.md)) |
| `npm test` | 화면 · 공용 JS 단위 테스트 |
| `npm run vendor` | 오픈소스 라이브러리(Milkdown, yaml, Plyr 등)를 `app/vendor/` 로 다시 묶기 |
| `npm run icons` | 아이콘 시안(`assets/source/`)에서 ico·png 아이콘 다시 만들기 (ImageMagick 필요) |
| `npm run stage -- <plan\|build\|feedback> <버전> "<요약>"` | 단계 기록 (버전·히스토리·커밋·태그·백업) |
| `npm run android:preview` | 안드로이드 휴대폰 화면을 PC 브라우저에서 미리보기 (`http://localhost:8790/m/index.html`) |
| `npm run android:smoke` | 안드로이드 화면 자동 점검 (휴대폰 크기 크로미움, Playwright 필요) |
| `cd android && ./gradlew assembleDebug` | 안드로이드 APK 만들기 (JDK 17 · Android SDK) |
| `node scripts/ai-bench.mjs --server <llama-server.exe> --vault <메모 폴더> --model <gguf>… --embed <gguf>…` | 로컬 AI 모델 비교 (인터넷 없이): [llama.cpp](https://github.com/ggml-org/llama.cpp) 의 llama-server 로 모델마다 맞춤법 · 문체 · 메모 찾기를 풀려 `ai-bench-결과.md` 로 |

AI 엔진(llama-server)은 앱이 처음 쓸 때 받아 설정 폴더 `ai\engine` 에 둬요. 다른 엔진을 쓰려면 `MEMOKING_LLAMA_SERVER` 로 경로를 줘요.

사용한 오픈소스와 라이선스: [app/vendor/LICENSES.md](../app/vendor/LICENSES.md)

```
app/          공용 화면 (PC · 안드로이드 공통 UI)
  js/core/    플랫폼 독립 로직: 메모 파일 형식, 색인, 날짜 찾기 …
  vendor/     묶어 넣은 오픈소스 (npm run vendor 로 생성)
desktop-rs/   PC 판 (Rust + Tauri)
  app/        앱 본체: 창 · 알림 영역 · 단축키 · 메모 폴더 · 동기화 (src/), preload.cjs · shim.js (화면 쪽 API)
  core/       플랫폼 독립 로직의 Rust 판 (메모 파일, 볼트, 색인, 일정 …) + parity 답
  parity/     공용 JS 의 답 만들기
android/      안드로이드 앱 (Kotlin 셸 + 휴대폰 화면 web/, 공용 화면 app/ 를 그대로 묶음)
assets/       아이콘 원본 시안(source/)과 생성된 아이콘(icons/)
tests/        화면 · 공용 JS 단위 테스트
scripts/      라이브러리 묶기, PowerShell 도우미(매직 카피 · 알림 모으기), 릴리스 글, 단계 기록
docs/         앱 소개 · 개인정보 처리방침 웹페이지
guides/       기능 · 개발 · 배포 자세한 안내
```
