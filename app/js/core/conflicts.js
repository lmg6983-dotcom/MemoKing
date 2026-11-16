// 동기화 충돌 사본: "제목 (PC 충돌 2026-11-15 1530).md" · "제목 (휴대폰 충돌 2026-11-15 1530 2).md" (PC sync-engine.js · 휴대폰 SyncEngine.kt 가 만든다)
//   PC · 휴대폰의 "원본과 견주기" 가 함께 쓴다
export const CONFLICT_TAG = / \((?:PC|휴대폰) 충돌 \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?=\.md$)/;

/** 충돌 사본 파일 → 원본 파일 (사본이 아니면 null) */
export const originalFileOf = (file) => (file && CONFLICT_TAG.test(file) ? file.replace(CONFLICT_TAG, '') : null);
