# 메모킹 작업 규칙

- 코드를 쓸 때는 `.claude/skills/ponytail` 스킬(full)을 따른다. 리뷰는 `ponytail-review`.
- 머지와 배포(태그 · 릴리스)는 사용자가 지시할 때만 한다. push(CI 가 돈다) · PR 도 지시할 때만 — 그 전에는 로컬 커밋까지만.
- 커밋 · PR · 릴리스 글은 [CONTRIBUTING.md](CONTRIBUTING.md) 형식(Conventional Commits)을 따른다.
- 한 곳을 고치면 같은 일을 하는 다른 곳도 시키지 않아도 함께 고친다: 메모 창 ↔ 목록 창, PC ↔ 휴대폰, JS ↔ Rust 같은 규칙(parity), 화면 ↔ 안내 문구 · 튜토리얼 · 문서. 고치기 전에 같은 기능을 쓰는 곳을 찾아 보고, 일부러 남긴 곳은 끝에 알린다.
