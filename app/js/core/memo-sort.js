// 메모 목록 정렬 (PC 목록 창 · 휴대폰 목록이 같이 쓴다, 순수 함수 — tests/memo-sort.test.js)
//   고정한 메모는 어떤 정렬이든 늘 맨 앞. 같으면 최근 수정순으로 (순서가 흔들리지 않게)

export const SORTS = [
  { id: 'updated', label: '최근 수정순' },
  { id: 'oldest', label: '오래된 순' },
  { id: 'created', label: '최근 만든 순' },
  { id: 'views', label: '많이 본 순' },
  { id: 'title', label: '이름순 (가나다)' },
];
export const DEFAULT_SORT = 'updated';
export const sortLabel = (id) => (SORTS.find((s) => s.id === id) ?? SORTS[0]).label;
export const validSort = (id) => (SORTS.some((s) => s.id === id) ? id : DEFAULT_SORT);

const time = (v) => Date.parse(v) || 0;
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

const BY = {
  updated: (a, b) => time(b.updated) - time(a.updated),
  oldest: (a, b) => time(a.updated) - time(b.updated),
  created: (a, b) => time(b.created) - time(a.created),
  views: (a, b) => (b.views ?? 0) - (a.views ?? 0),
  title: (a, b) => collator.compare(a.title ?? '', b.title ?? ''),
};

/** @param {{ pinned?: boolean, updated?: string, created?: string, views?: number, title?: string }[]} memos */
export function sortMemos(memos, sort = DEFAULT_SORT) {
  const by = BY[sort] ?? BY.updated;
  return [...memos].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || by(a, b) || BY.updated(a, b));
}
