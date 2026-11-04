# 개발 안내

[← README](../README.md)

## 개발용 실행

필요한 것: [Node.js](https://nodejs.org) 22 이상

- `메모킹 실행.cmd` 더블클릭 (검은 창은 잠시 후 저절로 닫히고 메모킹은 계속 실행됩니다), 또는
- 터미널에서 `npm start` (로그를 보면서 실행, 터미널을 닫으면 앱도 꺼짐)

## 명령

| 명령 | 설명 |
|---|---|
| `npm start` | 앱 실행 |
| `npm test` | 단위 테스트 |
| `npm run smoke` | 자동 점검 (앱을 띄워 사용자처럼 조작하고 결과 파일·화면을 확인한 뒤 종료, 캡처는 `out/`) |
| `npm run smoke:clipboard` | 실제 Windows 클립보드로 붙여넣기 점검 (메모장·웹·워드·캡처·탐색기 형식). 점검 중 클립보드를 바꾸고 끝나면 되돌림 |
| `npm run smoke:new` | 이번 버전에서 바뀐 기능만 확인하는 짧은 점검 (`desktop/smoke-new.js`, 버전마다 바꿔 씀) — 평소에는 이것만 |
| `npm run dist` | 배포판(설치 파일) 만들기 → `dist/MemoKing-Setup-<버전>.exe`, 이어서 빌드된 앱으로 자동 점검 ([electron-builder](https://github.com/electron-userland/electron-builder)) |
| `npm run launch` | 앱을 띄우고 터미널은 바로 끝냄 (`메모킹 실행.cmd` 가 사용) |
| `npm run llama` | 로컬 AI 엔진(llama.cpp `llama-server.exe` · Vulkan) 받기 → `desktop/vendor/llama/` (git 에는 없음, `npm run dist` 가 먼저 부름). 개발 중에는 `MEMOKING_LLAMA_SERVER` 로 다른 엔진 경로도 |
| `npm run vendor` | 오픈소스 라이브러리(Milkdown, yaml, Plyr)를 `app/vendor/` 로 다시 묶기 |
| `npm run icons` | 아이콘 시안(`assets/source/`)에서 ico·png 아이콘 다시 만들기 (ImageMagick 필요) |
| `npm run stage -- <plan\|build\|feedback> <버전> "<요약>"` | 단계 기록 (버전·히스토리·커밋·태그·백업) |
| `npm run android:preview` | 안드로이드 휴대폰 화면을 PC 브라우저에서 미리보기 (`http://localhost:8790/m/index.html`) |
| `npm run android:smoke` | 안드로이드 화면 자동 점검 (휴대폰 크기 크로미움, Playwright 필요) |
| `cd android && ./gradlew assembleDebug` | 안드로이드 APK 만들기 (JDK 17 · Android SDK) |
| `node scripts/ai-bench.mjs --server <llama-server.exe> --vault <메모 폴더> --model <gguf>… --embed <gguf>…` | 로컬 AI 모델 비교 (인터넷 없이): [llama.cpp](https://github.com/ggml-org/llama.cpp) 의 llama-server 로 모델마다 맞춤법 · 문체 · 태그 · 메모 찾기를 풀려 `ai-bench-결과.md` 로 (속도 · 메모리 · 한자 섞임 · 지금 앱 방식과 비교) |

사용한 오픈소스와 라이선스: [app/vendor/LICENSES.md](../app/vendor/LICENSES.md)

```
app/        공용 웹 코어 (데스크탑·안드로이드 공통 UI)
  js/core/  플랫폼 독립 로직: 메모 파일 형식, LLM 인덱서
  vendor/   묶어 넣은 오픈소스 (npm run vendor 로 생성)
  assets/   화면용 로고 이미지
desktop/    Electron 셸 (창·알림 영역 관리, 메모 폴더 읽기·쓰기·감시)
android/    안드로이드 앱 (Kotlin 셸 + 휴대폰 화면 web/, 공용 웹 코어 app/ 를 그대로 묶음)
assets/     아이콘 원본 시안(source/)과 생성된 아이콘(icons/)
tests/      단위 테스트
scripts/    실행기, 라이브러리 묶기, 단계 기록·백업
docs/       앱 소개 · 개인정보 처리방침 웹페이지
guides/     기능 · 개발 · 배포 자세한 안내
backups/    단계별 zip 스냅샷 (git 제외)
```
