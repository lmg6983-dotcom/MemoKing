// 메모 목록 정렬 (PC 목록 창 · 휴대폰 목록이 같이 쓴다, 순수 함수 — tests/memo-sort.test.js)
//   상단 고정한 메모는 어떤 정렬이든 늘 맨 앞, 그 안에서는 나중에 고정한 것이 위 (고정한 때를 모르는 예전 고정은 그 아래, 고른 정렬로).
//   같으면 최신순으로, 만든 시각 · id 순 (순서가 흔들리지 않게)

export const SORTS = [
  { id: 'updated', label: '최신순' }, // 최근에 고친 메모가 앞
  { id: 'oldest', label: '오래된순' },
  { id: 'views', label: '많이 본 순' },
  { id: 'title', label: '이름순 (가나다)' },
];
export const DEFAULT_SORT = 'updated';
export const sortLabel = (id) => (SORTS.find((s) => s.id === id) ?? SORTS[0]).label;
export const validSort = (id) => (SORTS.some((s) => s.id === id) ? id : DEFAULT_SORT);

const time = (v) => Date.parse(v) || 0;
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

// 수정 시각 · 제목이 모두 같으면 늦게 만든 것이 앞, 그래도 같으면 id 순 — 폴더를 다시 읽을 때마다 같은 것끼리 자리가 뒤섞이지 않게 (desktop-rs core vault.rs sorted 와 같게)
const byCreated = (a, b) => time(b.created) - time(a.created);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const BY = {
  updated: (a, b) => time(b.updated) - time(a.updated),
  oldest: (a, b) => time(a.updated) - time(b.updated),
  views: (a, b) => (b.views ?? 0) - (a.views ?? 0),
  title: (a, b) => collator.compare(a.title ?? '', b.title ?? ''),
};

/** @param {{ pinned?: boolean, pinnedAt?: string|null, updated?: string, created?: string, views?: number, title?: string }[]} memos */
export function sortMemos(memos, sort = DEFAULT_SORT) {
  const by = BY[sort] ?? BY.updated;
  const pinned = (a, b) => (a.pinned && b.pinned ? time(b.pinnedAt) - time(a.pinnedAt) : 0);
  return [...memos].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || pinned(a, b) || by(a, b) || BY.updated(a, b) || byCreated(a, b) || byId(a, b));
}
