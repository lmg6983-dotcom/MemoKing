# 배포와 자동 업데이트

[← README](../README.md)

## 자동 업데이트 배포 (비공개 소스 + 공개 배포 저장소)

소스는 이 비공개 저장소에만 두고, 설치 파일만 공개 저장소 **`lmg6983-dotcom/memoking-releases`** 의 Release 에 올립니다. 앱은 공개 저장소의 Release 만 보며 **앱 · 설치 파일에 토큰이 없습니다** (공개 저장소라 읽기에 필요 없음).

```
[비공개 MemoKing]  git tag v0.39.0 && git push origin v0.39.0
      │  .github/workflows/release.yml (windows-latest)
      │  ① 태그 = package.json 버전 확인 ② npm test ③ scripts/build-dist.mjs --publish always (GH_TOKEN = 공개 저장소 전용 PAT)
      ▼
[공개 memoking-releases]  Release v0.39.0: MemoKing-Setup-0.39.0.exe · .blockmap · latest.yml · MemoKing-Setup.exe
      ▲  latest.yml 확인 (켤 때 8초 뒤 · 4시간마다 · 절전 해제 · 설정 › 업데이트 확인)
[설치된 메모킹 v0.38.0]  desktop/updater.js (electron-updater, autoDownload 끔)
      → 새 버전 대화 상자(바뀐 점 = README 이 버전 줄) → 받기(진행률) → 지금 재시작(쓰던 메모 저장 후) / 나중에(끝낼 때 설치, 24시간 다시 묻지 않음)
```

- 최신 설치 파일 (로그인 필요 없음): `https://github.com/lmg6983-dotcom/memoking-releases/releases/latest/download/MemoKing-Setup.exe`
- 설정: `scripts/build-dist.mjs` — nsis `perMachine: false` · `oneClick: false`, `publish: github (memoking-releases, releaseType: release)`. 빌드가 끝나면 `dist/` 에 `latest.yml` · `.blockmap` 이 있는지 스스로 확인하고 없으면 실패합니다.
- 앱: `desktop/updater.js` (main) · `desktop/preload.cjs` 의 `update` · `app/js/list.js` (설정 › 업데이트, 새 버전 대화 상자). 개발 실행(`app.isPackaged` 아님)에서는 확인하지 않습니다.

**처음 한 번 준비**

1. 공개 저장소 만들기: GitHub › New repository › 이름 `memoking-releases` · **Public** · README 만 (소스는 올리지 않음)
2. 토큰 만들기: GitHub › Settings › Developer settings › Personal access tokens › **Fine-grained tokens** › Generate new token
   - Repository access: **Only select repositories › memoking-releases**
   - Permissions › Repository permissions › **Contents: Read and write** (나머지는 없음) · 만료일은 1년 이하 권장
3. 이 비공개 저장소 › Settings › Secrets and variables › Actions › New repository secret
   - `MEMOKING_RELEASES_TOKEN` = 위 토큰 (필수)
   - `MEMOKING_GOOGLE_CLIENT_ID` · `MEMOKING_GOOGLE_CLIENT_SECRET` (있던 것 그대로 — Google 로그인 연결 정보)

**배포:** `package.json` 의 버전을 올리고 README 이력에 그 버전 줄을 쓴 뒤 → `git tag v0.39.0 && git push origin v0.39.0` (또는 Actions › Release (PC) › Run workflow 에서 main — package.json 버전으로)

**테스트 순서:** ① v0.38.0 을 위 링크로 설치 ② 버전을 0.38.1 로 올려 태그 푸시 → Actions 가 공개 저장소에 Release v0.38.1 을 만듦 ③ 설치된 앱에서 설정 › 업데이트 확인 → 대화 상자 → 받기(진행률) → 지금 재시작 → 설정의 지금 버전이 v0.38.1

**자주 나는 문제**

| 증상 | 까닭 · 해결 |
|---|---|
| "업데이트 정보를 찾지 못했어요" (latest.yml 404) | 공개 저장소에 Release 가 없거나 **초안(draft)** · 사전 배포(prerelease) 로 올라감 → Release 를 정식(Latest)으로. 설정이 `releaseType: 'release'` 인지 |
| Actions 의 올리기 단계 403 · 404 | 토큰이 memoking-releases 를 고르지 않았거나 Contents 쓰기가 없음 · 만료 → 토큰 다시 만들어 Secret 바꾸기 |
| "태그와 package.json 버전이 달라요" | 태그 `v0.39.0` 이면 package.json 도 `0.39.0` |
| 개발 실행에서 업데이트 확인이 안 됨 | 정상 — 설치판(app-update.yml 이 있는 앱)에서만 확인 |
| 설치 폴더 권한 오류 | 사용자별 설치(%LOCALAPPDATA%\Programs) 라 보통 없음. 예전에 관리자 권한으로 Program Files 에 설치했다면 지우고 새로 설치 |
| "서명을 확인하지 못해…" | 서명이 바뀐(또는 생긴) 첫 업데이트에서 날 수 있음 — 아래 서명 참고 |

**코드 서명 (지금은 없음)**

- 없을 때: 처음 설치 · 실행 때 SmartScreen "Windows의 PC 보호" (추가 정보 › 실행). electron-updater 는 서명이 **없으면** 서명을 확인하지 않고 설치합니다. 대신 위변조를 서명으로 막지 못하므로 공개 저장소 · 토큰 관리가 더 중요합니다.
- 도입 체크리스트: ☐ OV/EV 코드 서명 인증서 구입 (EV 는 SmartScreen 평판이 바로, 하드웨어 토큰 · 클라우드 서명 필요) ☐ 빌드에 서명 연결 (electron-builder `win.signtoolOptions` 또는 Azure Trusted Signing — **electron.build 의 Code Signing 문서 확인 필요**) ☐ 서명한 첫 버전을 배포하면 그 뒤 업데이트는 같은 게시자 이름(publisherName)인지 확인되므로, 인증서를 바꿀 때 게시자 이름이 같아야 함 ☐ 서명 비밀값은 Secrets 에만
- 백신 오탐: 서명 없는 새 설치 파일 · PowerShell 도우미를 쓰는 앱은 오탐이 날 수 있음 → 같은 파일로 Microsoft Security Intelligence(제출 페이지)에 오탐 신고, 서명 도입이 가장 확실한 대책
- electron-builder: 지금 v26.15.3(npm 정식 최신). v27 은 아직 알파(27.0.0-alpha.x) — 올릴 때 per-machine 설치 · 웹 설치기(nsis-web) 관련 바뀐 점을 **electron.build 의 v27 이전 안내(마이그레이션)에서 확인 필요** (이 앱은 perMachine: false · nsis(웹 설치기 아님)라 영향이 적을 것으로 보이나 확인 전)
