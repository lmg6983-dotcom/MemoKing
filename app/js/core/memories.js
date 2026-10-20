// 회상 달력: 날짜마다 그날 남긴 메모 · 사진을 모은다 (순수 함수 — PC · 휴대폰 같이, tests/memories.test.js)
//   어느 날로 치나: "이 날의 기록으로" 정한 날(meta.day) → 없으면 메모를 만든 날 (현지 날짜)
//   잠긴 메모 · 빈 메모는 빼고, 태그를 고르면 그 태그가 붙은 메모만

const pad = (n) => String(n).padStart(2, '0');
/** 현지 날짜 "YYYY-MM-DD" */
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** "YYYY-MM-DD" → 그날 0시 (현지) */
export const keyDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** 메모의 날 ("YYYY-MM-DD", 모르면 null) */
export function memoryDay(memo) {
  if (typeof memo.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(memo.day)) return memo.day;
  const t = Date.parse(memo.created ?? '') || Date.parse(memo.updated ?? '');
  return t ? dayKey(new Date(t)) : null;
}

const isBlank = (m) => !String(m.title ?? '').trim() && !String(m.preview ?? '').trim() && !(m.images?.length);
const sameTag = (a, b) => a.toLocaleLowerCase('ko') === b.toLocaleLowerCase('ko');

/**
 * @param {{ id: string, title?: string, preview?: string, color?: string, created?: string, updated?: string, day?: string,
 *           images?: string[], tags?: string[], locked?: boolean }[]} memos
 * @param {{ from?: string, to?: string, tags?: string[] }} [o] from · to: "YYYY-MM-DD" (to 는 그날까지) · tags: 하나라도 붙은 메모만
 * @returns {Map<string, { day: string, memos: object[], photos: { src: string, memoId: string, title: string }[] }>} 날 순서대로
 */
export function collectMemories(memos, { from = '', to = '', tags = [] } = {}) {
  const days = new Map();
  for (const m of memos) {
    if (m.locked || isBlank(m)) continue;
    if (tags.length && !(m.tags ?? []).some((t) => tags.some((x) => sameTag(t, x)))) continue;
    const day = memoryDay(m);
    if (!day || (from && day < from) || (to && day > to)) continue;
    if (!days.has(day)) days.set(day, { day, memos: [], photos: [] });
    days.get(day).memos.push(m);
  }
  const time = (m) => Date.parse(m.created ?? '') || 0;
  for (const d of days.values()) {
    d.memos.sort((a, b) => time(a) - time(b)); // 그날 쓴 순서대로
    for (const m of d.memos) for (const src of m.images ?? []) d.photos.push({ src, memoId: m.id, title: m.title ?? '' });
  }
  return new Map([...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** 한 달 요약: 기록한 날 수 · 사진 수 · 표지 사진(날마다 첫 사진, 많으면 고르게 max 장) · 그 달 메모의 태그 */
export function monthSummary(days, max = 5) {
  const list = [...days.values()];
  const firsts = list.filter((d) => d.photos.length).map((d) => d.photos[0]);
  const step = firsts.length > max ? firsts.length / max : 1;
  const cover = firsts.length > max ? Array.from({ length: max }, (_, i) => firsts[Math.floor(i * step)]) : firsts;
  const tagCount = new Map();
  for (const d of list) for (const m of d.memos) for (const t of m.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  return {
    days: list.length,
    photos: list.reduce((n, d) => n + d.photos.length, 0),
    cover,
    tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')).map(([name, count]) => ({ name, count })),
  };
}

/** 기록이 있는 날 중 key 의 앞 · 뒤 날 (그날의 기록을 좌우로 넘길 때) */
export function neighborDays(days, key) {
  const keys = [...days.keys()];
  const i = keys.indexOf(key);
  return { prev: i > 0 ? keys[i - 1] : null, next: i >= 0 && i < keys.length - 1 ? keys[i + 1] : null };
}
