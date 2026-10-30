// 일정 탭 빠른 추가 자연어 파서 — 날짜 인식, 제목 추출, 단일·복수·기간 일정 해석
import { findDates } from './date-detect.js';

/**
 * 날짜 표현 및 불필요한 연결어/조사를 제외한 일정 제목 추출
 * @param {string} raw
 * @param {Array<{ from: number, to: number }>} hits
 * @returns {string}
 */
export function extractScheduleTitle(raw, hits) {
  if (!hits.length) return raw.replace(/\s+/g, ' ').trim().slice(0, 80);

  const spans = hits.map((h) => ({ from: h.from, to: h.to }));

  // 1) 날짜 바로 뒤의 '부터', '까지', '에는', '에', '쯤', '경'
  for (const s of spans) {
    const tail = raw.slice(s.to);
    const m = /^(\s*(?:부터|까지|에는|에|쯤|경))(?=\s|[,\.~]|$)/.exec(tail);
    if (m) s.to += m[0].length;
  }

  // 2) 날짜 사이의 연결어: ~, -, 그리고, 및, 와, 과, 랑, , 등 병합
  const merged = [];
  for (let i = 0; i < spans.length; i++) {
    if (merged.length === 0) {
      merged.push({ from: spans[i].from, to: spans[i].to });
    } else {
      const prev = merged[merged.length - 1];
      const curr = spans[i];
      const between = raw.slice(prev.to, curr.from);
      if (/^\s*(?:~|-|–|—|그리고|및|와|과|랑|,|\+)\s*$/.test(between)) {
        prev.to = curr.to;
      } else {
        merged.push({ from: curr.from, to: curr.to });
      }
    }
  }

  // 3) 날짜 구간 제거
  let result = '';
  let lastIdx = 0;
  for (const m of merged) {
    result += raw.slice(lastIdx, m.from) + ' ';
    lastIdx = m.to;
  }
  result += raw.slice(lastIdx);

  // 4) 앞뒤 연결어, 접속사, 공백 정리
  return result
    .replace(/(?:^|\s)(?:그리고|및|와|과|랑|~|-)(?=\s|$)/g, ' ')
    .replace(/^\s*(?:까지|에는|에|부터|은|는|이|가|의|쯤|경)(?=\s|$)/, '')
    .replace(/[\s,:·\-–~]+$/, '')
    .replace(/^[\s,:·\-–~]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 사용자 입력 텍스트를 파싱하여 생성할 일정 목록과 제목을 반환
 * @param {string} raw
 * @param {Date|null} [defaultDay] 캘린더에서 선택된 날짜 (날짜 미입력 시 사용)
 * @param {Date} [now]
 * @returns {{
 *   hits: Array<{ from: number, to: number, text: string, at: Date, hasTime: boolean }>,
 *   title: string,
 *   schedules: Array<{ type: 'single'|'range', start: Date, end?: Date, allDay: boolean }>,
 *   emptyTitle: boolean,
 *   needsDateChoice: boolean
 * }}
 */
export function parseScheduleText(raw, defaultDay = null, now = new Date()) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { hits: [], title: '', schedules: [], emptyTitle: true, needsDateChoice: false };
  }

  const hits = findDates(text, now, { allowPast: true });
  const title = extractScheduleTitle(text, hits);
  const emptyTitle = !title;

  if (hits.length === 0) {
    if (!defaultDay) {
      return { hits, title, schedules: [], emptyTitle, needsDateChoice: true };
    }
    const start = defaultDay instanceof Date ? defaultDay : new Date(defaultDay);
    return {
      hits,
      title,
      schedules: [{ type: 'single', start, allDay: true }],
      emptyTitle,
      needsDateChoice: false,
    };
  }

  // hits 가 2개 이상일 때 범위(range) vs 단일 복수(multi-single) 판별
  const schedules = [];
  let i = 0;
  while (i < hits.length) {
    if (i < hits.length - 1) {
      const h1 = hits[i];
      const h2 = hits[i + 1];
      const between = text.slice(h1.to, h2.from);
      const h1Tail = text.slice(h1.to);
      const h2Tail = text.slice(h2.to);

      const isRangeSymbol = /^\s*(?:~|-|–|—|to|until)\s*$/i.test(between);
      const isFromTo = /^\s*(?:부터|에서)\s*$/.test(between) ||
        (/^\s*(?:부터|에서)/.test(h1Tail) && /^\s*까지/.test(h2Tail)) ||
        /^\s*까지/.test(h2Tail);

      const isExplicitMulti = /(?:그리고|및|와|과|랑|,|\+)/.test(between);

      if (!isExplicitMulti && (isRangeSymbol || isFromTo)) {
        let start = h1.at;
        let end = h2.at;
        if (start > end) [start, end] = [end, start];
        schedules.push({
          type: 'range',
          start,
          end,
          allDay: !h1.hasTime && !h2.hasTime,
        });
        i += 2;
        continue;
      }
    }

      // 날짜 키워드(월, 일, 내일, 모레, 요일 등) 없이 시각만 적힌 경우(예: "치과 2시")
      // 캘린더에서 선택한 defaultDay 가 있으면 그 날짜에 시각을 결합한다
      const hasDateWord = /(?:\d{1,2}월|\d{1,2}일|내일|낼|모레|글피|어제|그제|요일|주말|\d{4}[-./])/.test(hits[i].text);
      let start = hits[i].at;
      if (!hasDateWord && hits[i].hasTime && defaultDay) {
        start = new Date(defaultDay.getFullYear(), defaultDay.getMonth(), defaultDay.getDate(), hits[i].at.getHours(), hits[i].at.getMinutes());
      }

      schedules.push({
        type: 'single',
        start,
        allDay: !hits[i].hasTime,
      });
      i += 1;
  }

  // 중복 날짜 정규화: 같은 날짜/시간의 중복 생성 방지
  const normalized = [];
  const seen = new Set();
  for (const s of schedules) {
    const key = s.type === 'single'
      ? `${s.type}|${s.start.getTime()}|${s.allDay}`
      : `${s.type}|${s.start.getTime()}|${s.end?.getTime()}|${s.allDay}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(s);
  }

  return {
    hits,
    title,
    schedules: normalized,
    emptyTitle,
    needsDateChoice: false,
  };
}

