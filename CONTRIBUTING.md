<div align="center">

# 🤝 메모킹에 기여하기

버그 제보, 아이디어, 코드 모두 반가워요.

</div>

## 🐞 이슈

- **버그**: [버그 제보](https://github.com/lmg6983-dotcom/MemoKing/issues/new?template=bug_report.yml) 양식에 버전 · 기기 · 다시 해 보는 순서를 적어 주세요.
- **아이디어**: [기능 제안](https://github.com/lmg6983-dotcom/MemoKing/issues/new?template=feature_request.yml) 양식에 "어떤 때 무엇이 불편한지"를 먼저 적어 주세요.

## 🔧 개발 준비

[Node.js](https://nodejs.org) 22 이상이면 돼요. 모든 명령과 폴더 구조는 [개발 안내](guides/DEVELOP.md)에 있어요.

```sh
npm start    # 앱 실행
npm test     # 단위 테스트 — PR 전에 꼭
npm run smoke  # 실제 Electron 자동 점검
```

## ✍️ 커밋 메시지

[Conventional Commits](https://www.conventionalcommits.org/ko/v1.0.0/) 형식으로 써요.

```text
<종류>(<범위>): <무엇이 바뀌었는지 — 50자 안팎>

<왜 바꿨는지, 무엇이 달라지는지. 72자에서 줄바꿈>

Closes #123
```

| 종류 | 쓸 때 | 종류 | 쓸 때 |
|---|---|---|---|
| `feat` | ✨ 새 기능 | `fix` | 🐛 버그 고침 |
| `perf` | ⚡ 더 빠르게 | `refactor` | ♻️ 동작은 그대로, 코드 정리 |
| `docs` | 📝 문서 | `test` | ✅ 테스트 |
| `build` | 📦 빌드 · 설치 파일 | `ci` | 👷 GitHub Actions |
| `style` | 🎨 화면 다듬기 | `chore` | 🔧 그 밖의 잡일 |

- **범위**는 고친 곳이에요: `pc` · `android` · `magic` · `sync` · `ai` · `editor` · `release` …
- 제목은 명령형 현재형, 끝에 마침표 없이. 예: `fix(android): 동영상 첫 장면이 검게 나오던 것`
- 하나의 커밋에는 하나의 변화만. 정리와 기능 변경은 나눠요.
- 호환이 깨지면 꼬리말에 `BREAKING CHANGE: <설명>`.

## 🔀 Pull Request

- 제목은 커밋 제목과 같은 형식이에요.
- 본문은 [PR 양식](.github/pull_request_template.md)의 **요약 · 바뀐 점 · 확인한 것**을 채워 주세요. 화면이 바뀌면 전후 사진을 붙여요.
- `PC 점검`과 `Android APK` 검사가 초록이어야 합쳐요.

## 🚀 릴리스 (관리자)

1. README 이력 표(`<!-- HISTORY:START -->` 아래) 맨 위에 한 줄을 더해요. 앱의 새 버전 안내와 GitHub 릴리스 본문이 이 한 줄에서 나와요.

   ```text
   | `v0.77.0` | 2026-11-06 | 3. 개선 | **한 줄 제목**: 무엇이 좋아졌는지. 다음 이야기 (휴대폰 0.55.0) |
   ```

   - `**제목**:` 은 굵은 소제목, 문장 끝 `. ` 마다 목록 한 줄이 돼요.
   - 휴대폰 버전이 함께 바뀌면 `(휴대폰 X.Y.Z)` 를 적어요 — 휴대폰 업데이트 안내가 이 표시로 줄을 찾아요.
2. `package.json` 버전을 맞추고 `vX.Y.Z` 태그를 올리면 [release.yml](.github/workflows/release.yml)이 설치 파일을 빌드해 릴리스를 만들어요.
3. 릴리스 본문(`scripts/release-body.mjs`)은 ✨ 바뀐 점 · 📥 받기 표 · 지난 버전과 비교 링크로 저절로 채워져요.

자세한 배포 설정은 [배포 안내](guides/RELEASE.md)에 있어요.

## 📜 라이선스

기여한 코드는 저장소와 같은 [MIT 라이선스](LICENSE)를 따라요.
