# 배포와 자동 업데이트

[← README](../README.md)

## 자동 업데이트 배포

소스와 설치 파일 모두 이 공개 저장소(**`lmg6983-dotcom/MemoKing`**)에 있어요. 앱은 이 저장소의 Release 를 토큰 없이 읽고, 올리기는 Actions 의 기본 토큰(`github.token`)으로 해서 따로 만들 토큰이 없어요.

```
git tag v0.76.0 && git push origin v0.76.0
      │  .github/workflows/release.yml (windows-latest)
      │  ① 태그 = package.json 버전 확인 ② npm test ③ scripts/build-dist.mjs --publish always
      ▼
Release v0.76.0: MemoKing-Setup-0.76.0.exe · .blockmap · latest.yml · MemoKing-Setup.exe
      ▲  latest.yml 확인 (켤 때 8초 뒤 · 4시간마다 · 절전 해제 · 설정 › 업데이트 확인)
설치된 메모킹  desktop/updater.js (electron-updater, autoDownload 끔)
      → 새 버전 대화 상자(바뀐 점 = README 이 버전 줄) → 받기(진행률) → 지금 재시작 / 나중에(끝낼 때 설치)
```

- 최신 설치 파일: `https://github.com/lmg6983-dotcom/MemoKing/releases/latest/download/MemoKing-Setup.exe`
- 휴대폰: `.github/workflows/android.yml` 이 main 에서 APK 를 만들면 사전 배포 `android` 에 `MemoKing-android.apk` · `android-latest.json` 을 올리고, 앱은 그것을 봐요. PC 설정의 휴대폰 설치 QR · 링크도 이 파일이라 **`android` 릴리스는 지우면 안 돼요** (지우면 링크가 404, 휴대폰 업데이트도 멈춤).
- 설정: `scripts/build-dist.mjs` — nsis `perMachine: false` · `oneClick: false`, `publish: github (MemoKing, releaseType: release)`. 빌드가 끝나면 `dist/` 에 `latest.yml` · `.blockmap` 이 있는지 스스로 확인하고 없으면 실패해요.
- Secrets: `MEMOKING_GOOGLE_CLIENT_ID` · `MEMOKING_GOOGLE_CLIENT_SECRET` (Google 로그인 연결 정보)

**배포:** `package.json` 의 버전을 올리고 README 이력에 그 버전 줄을 쓴 뒤 → `git tag v<버전> && git push origin v<버전>` (또는 Actions › Release (PC) › Run workflow 에서 main)

### 옛 배포 저장소(memoking-releases)

v0.75.3 까지는 설치 파일을 따로 둔 공개 저장소 `memoking-releases` 에 올렸어요. v0.76.0 을 양쪽에 올려 옛 앱이 이 저장소로 넘어오게 한 뒤 그 저장소는 지웠어요. 그래서 v0.76.0 으로 업데이트하지 않은 채 남은 옛 앱(PC v0.75.3 · 휴대폰 0.53.x 까지)은 새 버전을 찾지 못해요 — 위 최신 설치 파일 링크로 한 번 다시 설치하면 돼요 (메모는 그대로). Secret `MEMOKING_RELEASES_TOKEN` 은 이제 쓰지 않으니 지워도 돼요.

**자주 나는 문제**

| 증상 | 까닭 · 해결 |
|---|---|
| "업데이트 정보를 찾지 못했어요" (latest.yml 404) | Release 가 없거나 **초안(draft)** · 사전 배포(prerelease) 로 올라감 → Release 를 정식(Latest)으로. 설정이 `releaseType: 'release'` 인지 |
| 휴대폰 설치 링크 · QR 이 404 (`releases/download/android/…`) | 사전 배포 `android` 가 지워짐 → Actions › Android APK › Run workflow (main) 로 한 번 돌리면 다시 만들어 올려요 |
| Actions 의 올리기 단계 403 | 저장소 Settings › Actions › General › Workflow permissions 가 "Read and write" 인지 (워크플로는 `contents: write` 를 달라고 함) |
| "태그와 package.json 버전이 달라요" | 태그 `v0.39.0` 이면 package.json 도 `0.39.0` |
| 개발 실행에서 업데이트 확인이 안 됨 | 정상 — 설치판(app-update.yml 이 있는 앱)에서만 확인 |
| 설치 폴더 권한 오류 | 사용자별 설치(%LOCALAPPDATA%\Programs) 라 보통 없음. 예전에 관리자 권한으로 Program Files 에 설치했다면 지우고 새로 설치 |
| "서명을 확인하지 못해…" | 서명이 바뀐(또는 생긴) 첫 업데이트에서 날 수 있음 — 아래 서명 참고 |

**코드 서명 (SignPath Foundation — 승인 뒤 켬)**

오픈소스 프로젝트는 [SignPath Foundation](https://signpath.org) 에서 무료로 코드 서명을 받을 수 있어요. `release.yml` 에 서명 단계가 준비돼 있고, Secret `SIGNPATH_API_TOKEN` 이 생기면 저절로 켜져요 (없으면 지금처럼 서명 없이 배포).

- 흐름: 빌드 → 설치 파일을 Actions 산출물로 올림 → `signpath/github-action-submit-signing-request@v3` 가 서명 요청 · 서명본 받기 → `scripts/refresh-update-info.mjs` 가 서명본에 맞춰 `latest.yml` · `.blockmap` 을 다시 만듦 (서명하면 파일이 바뀌어 자동 업데이트의 sha512 확인이 어긋나므로) → Release 에 올림
- 켜는 법 (승인 뒤 한 번):
  1. SignPath 에서 이 저장소를 **Trusted Build System: GitHub.com** 으로 연결하고, 프로젝트(slug `MemoKing`) · 서명 정책(slug `release-signing`) · 산출물 설정을 만들어요. 산출물 설정은 zip 안의 설치 파일 하나를 서명하는 것: `<zip-file><pe-file path="MemoKing-Setup-*.exe"><authenticode-sign/></pe-file></zip-file>`
  2. SignPath 에서 CI 사용자를 만들고 그 API 토큰을 이 저장소 Settings › Secrets and variables › Actions › **Secrets** 에 `SIGNPATH_API_TOKEN` 으로
  3. 같은 화면의 **Variables** 에 `SIGNPATH_ORGANIZATION_ID` (SignPath 조직 ID). slug 를 다르게 지었으면 `SIGNPATH_PROJECT_SLUG` · `SIGNPATH_POLICY_SLUG` 도
  4. 버전을 올려 배포 → Actions 의 "SignPath 로 서명" 단계가 초록이고, 받은 설치 파일 › 속성 › 디지털 서명에 SignPath Foundation 이 보이면 끝
- 서명되는 것은 설치 파일(MemoKing-Setup.exe)이에요. 설치 화면의 SmartScreen 경고가 이것으로 사라져요 (평판이 쌓이는 동안 처음 몇 주는 남을 수 있음). 설치된 MemoKing.exe 는 설치 파일 안에 들어가 있어 서명되지 않아요
- 자동 업데이트: 앱 설정(app-update.yml)에 게시자 이름을 넣지 않아서 electron-updater 는 서명을 검사하지 않아요. 그래서 서명 없는 옛 버전에서 서명한 새 버전으로 문제없이 넘어가요
- SignPath Foundation 은 README 에 코드 서명 정책을 두라고 해요 → README 의 "코드 서명 정책"
- 없을 때: 처음 설치 · 실행 때 SmartScreen "Windows의 PC 보호" (추가 정보 › 실행)
- 백신 오탐: 서명 없는 새 설치 파일 · PowerShell 도우미를 쓰는 앱은 오탐이 날 수 있음 → 같은 파일로 Microsoft Security Intelligence(제출 페이지)에 오탐 신고, 서명 도입이 가장 확실한 대책
- electron-builder: 지금 v26.15.3(npm 정식 최신). v27 은 아직 알파(27.0.0-alpha.x) — 올릴 때 per-machine 설치 · 웹 설치기(nsis-web) 관련 바뀐 점을 **electron.build 의 v27 이전 안내(마이그레이션)에서 확인 필요** (이 앱은 perMachine: false · nsis(웹 설치기 아님)라 영향이 적을 것으로 보이나 확인 전)
