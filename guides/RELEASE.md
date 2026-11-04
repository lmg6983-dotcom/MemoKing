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
- 휴대폰: `.github/workflows/android.yml` 이 main 에서 APK 를 만들면 사전 배포 `android` 에 `MemoKing-android.apk` · `android-latest.json` 을 올리고, 앱은 그것을 봐요.
- 사전 배포 `desktop` 은 main 이 바뀔 때마다 만드는 시험용 설치 파일이에요 (`desktop.yml`). 사전 배포라 "최신 릴리스" 링크와 자동 업데이트에는 걸리지 않아요.
- 설정: `scripts/build-dist.mjs` — nsis `perMachine: false` · `oneClick: false`, `publish: github (MemoKing, releaseType: release)`. 빌드가 끝나면 `dist/` 에 `latest.yml` · `.blockmap` 이 있는지 스스로 확인하고 없으면 실패해요.
- Secrets: `MEMOKING_GOOGLE_CLIENT_ID` · `MEMOKING_GOOGLE_CLIENT_SECRET` (Google 로그인 연결 정보)

**배포:** `package.json` 의 버전을 올리고 README 이력에 그 버전 줄을 쓴 뒤 → `git tag v<버전> && git push origin v<버전>` (또는 Actions › Release (PC) › Run workflow 에서 main)

### 옛 배포 저장소(memoking-releases)에서 옮기기

v0.75.3 까지 설치한 앱은 옛 저장소 `memoking-releases` 에서 새 버전을 찾아요. 그래서 옮기는 동안은 Secrets 에 `MEMOKING_RELEASES_TOKEN` 을 남겨 두면, 새 버전을 그쪽에도 같이 올려요 (`release.yml` · `android.yml` 의 "옮기는 동안만" 단계). 옛 앱이 그 버전으로 업데이트되면 그때부터 이 저장소를 봐요.

1. 새 버전을 한 번 배포해요. 이 저장소와 옛 저장소 양쪽에 올라가요.
2. 쓰는 PC · 휴대폰이 모두 새 버전으로 업데이트됐는지 확인해요 (설정의 지금 버전).
3. 그다음 `memoking-releases` 저장소와 Secret `MEMOKING_RELEASES_TOKEN` 을 지워요. 옛 저장소로 올리는 단계는 비밀값이 없으면 저절로 건너뛰어요.

**자주 나는 문제**

| 증상 | 까닭 · 해결 |
|---|---|
| "업데이트 정보를 찾지 못했어요" (latest.yml 404) | Release 가 없거나 **초안(draft)** · 사전 배포(prerelease) 로 올라감 → Release 를 정식(Latest)으로. 설정이 `releaseType: 'release'` 인지 |
| Actions 의 올리기 단계 403 | 저장소 Settings › Actions › General › Workflow permissions 가 "Read and write" 인지 (워크플로는 `contents: write` 를 달라고 함) |
| "태그와 package.json 버전이 달라요" | 태그 `v0.39.0` 이면 package.json 도 `0.39.0` |
| 개발 실행에서 업데이트 확인이 안 됨 | 정상 — 설치판(app-update.yml 이 있는 앱)에서만 확인 |
| 설치 폴더 권한 오류 | 사용자별 설치(%LOCALAPPDATA%\Programs) 라 보통 없음. 예전에 관리자 권한으로 Program Files 에 설치했다면 지우고 새로 설치 |
| "서명을 확인하지 못해…" | 서명이 바뀐(또는 생긴) 첫 업데이트에서 날 수 있음 — 아래 서명 참고 |

**코드 서명 (지금은 없음)**

- 없을 때: 처음 설치 · 실행 때 SmartScreen "Windows의 PC 보호" (추가 정보 › 실행). electron-updater 는 서명이 **없으면** 서명을 확인하지 않고 설치합니다. 대신 위변조를 서명으로 막지 못하므로 공개 저장소 · 토큰 관리가 더 중요합니다.
- 도입 체크리스트: ☐ OV/EV 코드 서명 인증서 구입 (EV 는 SmartScreen 평판이 바로, 하드웨어 토큰 · 클라우드 서명 필요) ☐ 빌드에 서명 연결 (electron-builder `win.signtoolOptions` 또는 Azure Trusted Signing — **electron.build 의 Code Signing 문서 확인 필요**) ☐ 서명한 첫 버전을 배포하면 그 뒤 업데이트는 같은 게시자 이름(publisherName)인지 확인되므로, 인증서를 바꿀 때 게시자 이름이 같아야 함 ☐ 서명 비밀값은 Secrets 에만
- 백신 오탐: 서명 없는 새 설치 파일 · PowerShell 도우미를 쓰는 앱은 오탐이 날 수 있음 → 같은 파일로 Microsoft Security Intelligence(제출 페이지)에 오탐 신고, 서명 도입이 가장 확실한 대책
- electron-builder: 지금 v26.15.3(npm 정식 최신). v27 은 아직 알파(27.0.0-alpha.x) — 올릴 때 per-machine 설치 · 웹 설치기(nsis-web) 관련 바뀐 점을 **electron.build 의 v27 이전 안내(마이그레이션)에서 확인 필요** (이 앱은 perMachine: false · nsis(웹 설치기 아님)라 영향이 적을 것으로 보이나 확인 전)
