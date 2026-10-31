// 태그 — 본문의 #태그 (Obsidian 과 같은 관례). 따로 저장하지 않고 본문에서 읽는다. (순수 함수, 단위 테스트 대상)
//   태그 글자: 글자(한글·영문 등)·숫자·_·-   숫자만(#1)은 태그가 아님
//   "# 제목"(띄어쓰기)은 제목, 주소 속 #(a.com/#x)·코드 안·HTML 색(#e03131)은 태그가 아님

export const TAG_CHAR = '[\\p{L}\\p{N}\\p{M}_\\-]';
// # 앞은 줄 처음이거나 띄어쓰기·괄호·문장부호, 또는 굵게·기울임·취소선 기호(**#태그**, *#태그*, ~~#태그~~)
// (주소나 낱말 속 # 는 제외)
const TAG_RE = new RegExp(`(^|[\\s(\\[{,;:!?'"“‘>*_~])#(${TAG_CHAR}+)`, 'gu');

export function isValidTag(name) {
  return new RegExp(`^${TAG_CHAR}+$`, 'u').test(name) && !/^[\d_-]+$/.test(name);
}

/** 글 한 줄(서식 없는 글자)에서 태그 위치: [{ index: '#' 위치, length, name }] */
export function findTags(text) {
  const found = [];
  for (const m of String(text ?? '').matchAll(TAG_RE)) {
    const name = m[2].replace(/[-_]+$/, ''); // 끝의 - 는 문장부호, _ 는 서식 기호(__#태그__)로 본다
    if (!isValidTag(name)) continue;
    found.push({ index: m.index + m[1].length, length: name.length + 1, name });
  }
  return found;
}

const keyOf = (name) => name.toLocaleLowerCase('ko');

/** 메모 본문(마크다운)의 태그 목록 (처음 나온 순, 대소문자 다른 같은 태그는 하나로) */
export function extractTags(body) {
  const tags = new Map();
  let fence = false;
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence || /^( {4}|\t)/.test(raw)) continue;
    const line = raw
      .replace(/`[^`]*`/g, ' ') // 코드
      .replace(/\]\([^)]*\)/g, '] ') // 링크·그림 주소
      .replace(/<[^>]*>/g, ' ') // HTML 태그·자동 링크 (<span style="color: #e03131"> 등)
      .replace(/\\#/g, '#'); // 줄 맨 앞 #태그 를 마크다운 도구가 \#태그 로 쓴 경우
    for (const t of findTags(line)) if (!tags.has(keyOf(t.name))) tags.set(keyOf(t.name), t.name);
  }
  return [...tags.values()];
}

/**
 * 마크다운 도구는 줄 맨 앞(목록·인용 기호 뒤 포함)의 # 를 제목으로 오해하지 않게 \# 로 쓴다.
 * 그런데 #태그 처럼 # 바로 뒤에 글자가 오면 원래 제목이 아니므로 되돌려 파일에 #태그 로 남긴다 (코드 안은 그대로).
 */
export function unescapeTags(md) {
  let fence = false;
  return String(md ?? '').split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    // 줄 맨 앞 띄어쓰기(&#x20;)는 보이지도 않으니 버린다 — " #할일" 처럼 띄우고 태그를 쳐도 "&#x20;\#할일" 이 되지 않게
    const trimmed = line.replace(/^((?:\s*>)*\s*(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] )?)(?:&#x20;)+/, '$1');
    return trimmed.replace(new RegExp(`(^|[\\s>\\]])\\\\#(?=${TAG_CHAR})`, 'gu'), '$1#');
  }).join('\n');
}

/** 여러 메모의 태그를 모아 [{ name, count }] (많이 쓴 순 → 가나다순) */
export function collectTags(memos) {
  const all = new Map();
  for (const m of memos) {
    for (const name of m.tags ?? []) {
      const key = keyOf(name);
      const t = all.get(key) ?? { name, count: 0 };
      t.count++;
      all.set(key, t);
    }
  }
  return [...all.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
}

/** 자동완성 후보: 이어 친 글자로 시작하는 태그 먼저, 그다음 글자를 포함하는 태그 */
export function suggestTags(tags, prefix, limit = 8) {
  const p = keyOf(prefix ?? '');
  if (!p) return tags.slice(0, limit);
  const starts = tags.filter((t) => keyOf(t.name).startsWith(p) && keyOf(t.name) !== p);
  const contains = tags.filter((t) => !keyOf(t.name).startsWith(p) && keyOf(t.name).includes(p));
  return [...starts, ...contains].slice(0, limit);
}

// ---------- 목록 필터 ----------

export const KIND_FILTERS = [
  { id: 'pinned', label: '고정', test: (m) => m.pinned },
  { id: 'reminder', label: '알림', test: (m) => m.reminderCount > 0 },
  { id: 'image', label: '사진', test: (m) => m.hasImage },
  { id: 'file', label: '파일', test: (m) => m.hasFile || m.hasAudio || m.hasVideo },
  { id: 'web', label: '웹 링크', test: (m) => m.hasWebLink },
];

/** 검색어에서 #태그 를 떼어 낸다: "#업무 회의" → { text: '회의', tags: ['업무'] } */
export function parseQuery(query) {
  const tags = [];
  const words = [];
  for (const w of String(query ?? '').trim().split(/\s+/).filter(Boolean)) {
    const name = w.startsWith('#') ? w.slice(1) : '';
    if (name && isValidTag(name)) tags.push(name);
    else words.push(w);
  }
  return { text: words.join(' '), tags };
}

/**
 * @param {object[]} memos 목록 요약 (tags, color, pinned, reminderCount, has*)
 * @param {{ tags?: string[], colors?: string[], kinds?: string[] }} filter
 *   태그: 모두 가진 메모 · 색: 그중 하나 · 담긴 것: 모두 해당
 */
export function filterMemos(memos, { tags = [], colors = [], kinds = [] } = {}) {
  const want = tags.map(keyOf);
  const kindTests = KIND_FILTERS.filter((k) => kinds.includes(k.id)).map((k) => k.test);
  return memos.filter((m) => {
    if (colors.length && !colors.includes(m.color)) return false;
    if (want.length) {
      const has = new Set((m.tags ?? []).map(keyOf));
      if (!want.every((t) => has.has(t))) return false;
    }
    return kindTests.every((test) => test(m));
  });
}

export const sameTag = (a, b) => keyOf(a) === keyOf(b);
