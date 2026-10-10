// 글 속의 날짜·시각 찾기 — "내일 오후 3시", "다음 주 화요일", "10월 12일 14:30", "30분 뒤" 같은 말을 찾아
// 그 시각(Date)으로. 편집기는 찾은 자리에 밑줄을 긋고, 누르면 그 시각에 알림을 맞춘다 (순수 함수, 단위 테스트 대상).
//   한국어는 직접(오픈소스 날짜 해석기 chrono 에 한국어가 없음), 영어는 chrono(MIT)를 넘겨받아 쓴다.
//   앞으로의 시각만 — 이미 지난 날짜·"오늘"만 있는 말은 알림을 맞출 수 없으므로 찾지 않는다.

const DAY_MS = 86_400_000;
export const DEFAULT_HOUR = 9; // 날짜만 적었으면 그날 아침 9시

const WEEKDAYS = '일월화수목금토';
const NUM = '(\\d{1,2})';
// 글자 사이 경계: 앞이 숫자·영문이면 다른 말의 일부 ("2026년" 의 "26년" 같은)
const NOT_AFTER = '(?<![0-9A-Za-z])';

// ---------- 날짜 ----------
// 각 규칙: re(전역 정규식), date(m, now) → {y, mo, d} 또는 null, time(선택) → 시각까지 정해지는 상대 표현
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const ymd = (d) => ({ y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() });
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekdayIndex = (ch) => WEEKDAYS.indexOf(ch);

// 이번 주 = 월요일에 시작하는 주 (한국 달력 관례)
function weekdayIn(now, weekOffset, wd) {
  const today = startOfDay(now);
  const mondayBased = (today.getDay() + 6) % 7; // 월=0 … 일=6
  const monday = addDays(today, -mondayBased);
  return addDays(monday, weekOffset * 7 + ((wd + 6) % 7));
}

const DATE_RULES = [
  // 2026-10-12, 2026.10.12, 2026/10/12 (뒤에 요일 괄호)
  {
    re: new RegExp(`${NOT_AFTER}(\\d{4})[-./]\\s?(\\d{1,2})[-./]\\s?(\\d{1,2})(?![0-9])\\.?`, 'g'),
    date: (m) => ({ y: +m[1], mo: +m[2] - 1, d: +m[3] }),
  },
  // (2026년) 10월 12일
  {
    re: new RegExp(`${NOT_AFTER}(?:(\\d{4})년\\s?)?${NUM}월\\s?${NUM}일`, 'g'),
    date: (m, now) => withYear(m[1], +m[2] - 1, +m[3], now),
  },
  // 10/12 — 분수(1/2)와 헷갈리지 않게 월·일 범위 안에서만, 앞뒤에 숫자·/ 없음
  {
    re: /(?<![0-9A-Za-z/.])(\d{1,2})\/(\d{1,2})(?![0-9/])/g,
    date: (m, now) => withYear(null, +m[1] - 1, +m[2], now),
    needsMore: true, // 뒤에 요일 괄호나 시각이 있을 때만 ("1/2 컵" 은 날짜가 아님)
  },
  // 오늘 · 내일 · 모레 · 글피 · 내일모레
  {
    re: /(?<![가-힣])(오늘|내일\s?모레|내일|낼|모레|글피)/g,
    date: (m, now) => ymd(addDays(now, { 오늘: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[m[1].replace(/\s/g, '')] ?? 2)),
    today: (m) => m[1] === '오늘',
  },
  // (이번|다음|다다음) 주 X요일, 담주 X요일
  {
    re: new RegExp(`(?<![가-힣])(이번|다음|담|다다음)\\s?주\\s?([${WEEKDAYS}])(?:요일|욜)`, 'g'),
    date: (m, now) => ymd(weekdayIn(now, { 이번: 0, 다음: 1, 담: 1, 다다음: 2 }[m[1]], weekdayIndex(m[2]))),
  },
  // 그냥 X요일 → 오늘부터 가장 가까운 그 요일 (오늘이 그 요일이면 오늘, 시각이 지났으면 다음 주)
  {
    re: new RegExp(`(?<![가-힣])([${WEEKDAYS}])요일`, 'g'),
    date: (m, now) => ymd(addDays(startOfDay(now), (weekdayIndex(m[1]) - now.getDay() + 7) % 7)),
    rollWeek: true,
  },
  // 다음 달 12일
  {
    re: /(?<![가-힣])(이번|다음)\s?달\s?(\d{1,2})일/g,
    date: (m, now) => {
      const mo = now.getMonth() + (m[1] === '다음' ? 1 : 0);
      const first = new Date(now.getFullYear(), mo, 1);
      return { y: first.getFullYear(), mo: first.getMonth(), d: +m[2] };
    },
  },
  // 3일 뒤 · 2주 후 (날짜만) / 30분 뒤 · 2시간 후 (시각까지)
  {
    re: /(?<![0-9])(\d{1,3})\s?(분|시간|일|주)\s?(뒤|후)(?![가-힣])/g,
    date: () => null,
    relative: (m, now) => {
      const n = +m[1];
      if (!n) return null;
      if (m[2] === '분') return { at: new Date(now.getTime() + n * 60_000), hasTime: true };
      if (m[2] === '시간') return { at: new Date(now.getTime() + n * 3_600_000), hasTime: true };
      return { date: ymd(addDays(now, m[2] === '주' ? n * 7 : n)) };
    },
  },
];

function withYear(year, mo, d, now) {
  if (year) return { y: +year, mo, d };
  // 연도가 없으면 올해 — 이미 지났으면 내년 (12월에 적은 "1월 3일")
  const thisYear = new Date(now.getFullYear(), mo, d, 23, 59);
  return { y: thisYear < now ? now.getFullYear() + 1 : now.getFullYear(), mo, d };
}

// ---------- 시각 ----------
// 오후 3시 · 3시 반 · 3시 20분 · 15:30 · 오후 3:30 · 아침 8시 · 정오 · 자정
// "시" 뒤에는 시간·시작·시험 같은 다른 말이 오면 안 된다
const AFTER_SI = '(?=$|[^가-힣]|반|에|엔|까지|부터|쯤|경|정각|전|에서|으로)';
const PERIOD = '(오전|오후|아침|낮|점심|저녁|밤|새벽)';
const TIME_RE = new RegExp(
  `(?:${PERIOD}\\s?)?(?:` +
    `${NOT_AFTER}(\\d{1,2}):(\\d{2})(?![0-9:])` + // 15:30
    `|${NOT_AFTER}(\\d{1,2})시(?:\\s?(반)|\\s?(\\d{1,2})분)?${AFTER_SI}` + // 3시 · 3시 반 · 3시 20분
    `)` +
    `|(?<![가-힣])(정오|자정)`,
  'g',
);

function timeOf(m) {
  if (m[7]) return m[7] === '정오' ? { h: 12, min: 0 } : { h: 24, min: 0 };
  const period = m[1];
  let h;
  let min;
  if (m[2] !== undefined) {
    h = +m[2];
    min = +m[3];
  } else {
    h = +m[4];
    min = m[5] ? 30 : m[6] !== undefined ? +m[6] : 0;
  }
  if (h > 24 || min > 59) return null;
  if (period === '오전' || period === '아침' || period === '새벽') {
    if (h === 12) h = 0;
    if (h > 12) return null;
  } else if (period === '오후' || period === '저녁' || period === '밤' || period === '낮' || period === '점심') {
    if (h > 12) return null;
    if (period === '밤' && h === 12) h = 24; // 밤 12시 = 그날 자정
    else if (period === '낮' || period === '점심') h = h <= 5 ? h + 12 : h === 12 ? 12 : h; // 낮 1시 = 13시, 낮 11시 = 11시
    else if (h < 12) h += 12;
  } else if (m[2] === undefined && h >= 1 && h <= 6) {
    h += 12; // "3시 회의" 처럼 오전·오후 없이 1~6시는 보통 오후
  }
  return { h, min, period: Boolean(period) };
}

/** 한 자리부터 시각 표현이 바로 이어지면 (사이에 "에" · "," · 빈칸) 그 시각 */
function timeAt(text, from) {
  const gap = /^(?:\s|에\s?|,\s?|\(\S{1,3}\)\s?)*/.exec(text.slice(from))[0].length;
  TIME_RE.lastIndex = from + gap;
  const m = TIME_RE.exec(text);
  if (!m || m.index !== from + gap) return null;
  const t = timeOf(m);
  return t ? { ...t, end: m.index + m[0].length } : null;
}

const atTime = (date, t) => new Date(date.y, date.mo, date.d, t.h, t.min);
const validDay = (date) => {
  const d = new Date(date.y, date.mo, date.d);
  return d.getFullYear() === date.y && d.getMonth() === date.mo && d.getDate() === date.d;
};

/**
 * 글 속 날짜·시각들 (앞에서부터, 겹치지 않게)
 * @param {string} text 한 줄(문단)의 글
 * @param {Date} [now]
 * @returns {{ from: number, to: number, text: string, at: Date, hasTime: boolean }[]}
 */
export function findDates(text, now = new Date()) {
  const s = String(text ?? '');
  const found = [];
  const taken = (from, to) => found.some((f) => from < f.to && to > f.from);
  const add = (from, to, at, hasTime) => {
    if (!(at instanceof Date) || Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() + 30_000) return;
    if (taken(from, to)) return;
    found.push({ from, to, text: s.slice(from, to).trim(), at, hasTime });
  };

  for (const rule of DATE_RULES) {
    rule.re.lastIndex = 0;
    for (const m of s.matchAll(rule.re)) {
      const from = m.index;
      let to = from + m[0].length;
      // "(토)" 같은 요일 괄호는 함께
      const paren = /^\s?\([월화수목금토일](?:요일)?\)/.exec(s.slice(to));
      if (paren) to += paren[0].length;
      // "지난 금요일" · "저번 주 화요일" 은 지난 날
      if (/(지난|저번)\s?(주\s?)?$/.test(s.slice(Math.max(0, from - 5), from))) continue;
      if (rule.relative) {
        const r = rule.relative(m, now);
        if (!r) continue;
        if (r.at) add(from, to, r.at, true);
        else {
          const t = timeAt(s, to);
          if (t) add(from, t.end, atTime(r.date, t), true);
          else add(from, to, atTime(r.date, { h: DEFAULT_HOUR, min: 0 }), false);
        }
        continue;
      }
      const date = rule.date(m, now);
      if (!date || date.mo < 0 || date.mo > 11 || !validDay(date)) continue;
      const t = timeAt(s, to);
      if (rule.needsMore && !paren && !t) continue;
      if (t) {
        let at = atTime(date, t);
        if (rule.rollWeek && at <= now) at = new Date(at.getTime() + 7 * DAY_MS);
        add(from, t.end, at, true);
      } else if (!rule.today?.(m)) {
        let at = atTime(date, { h: DEFAULT_HOUR, min: 0 });
        // 오늘이 그 요일이고 9시가 지났으면: 날짜만 적은 "금요일" 은 다음 주
        if (rule.rollWeek && at <= now) at = new Date(at.getTime() + 7 * DAY_MS);
        add(from, to, at, false);
      }
    }
  }

  // 날짜 없이 시각만: 오늘 그 시각 (이미 지났으면 찾지 않음 — 내일인지 알 수 없으므로)
  TIME_RE.lastIndex = 0;
  for (const m of s.matchAll(TIME_RE)) {
    const t = timeOf(m);
    if (!t) continue;
    // 오전·오후 없는 "12:30" 같은 숫자 시각만 있는 줄은 시간표·기록일 때가 많아 오전·오후·"시"가 있을 때만
    if (m[2] !== undefined && !t.period) continue;
    const today = ymd(now);
    add(m.index, m.index + m[0].length, atTime(today, t), true);
  }

  return found.sort((a, b) => a.from - b.from);
}

/**
 * 영어 날짜 (chrono 결과를 같은 모양으로) — chrono 는 vendor 에서 넘겨받는다
 * @param {string} text
 * @param {{ parse: (text: string, ref: Date, opt?: object) => any[] }} chrono chrono.en.casual 같은 것
 */
export function findEnglishDates(text, chrono, now = new Date()) {
  if (!chrono || !/[A-Za-z]/.test(text)) return [];
  const out = [];
  for (const r of chrono.parse(String(text), now, { forwardDate: true })) {
    const known = r.start.knownValues ?? {};
    const hasDay = 'day' in known || 'weekday' in known;
    const hasTime = 'hour' in known;
    if (!hasDay && !hasTime) continue; // "now" · "this" 같은 말은 빼고
    if (/^(now|today|tonight)$/i.test(r.text.trim())) continue;
    const at = r.start.date();
    if (!hasTime) at.setHours(DEFAULT_HOUR, 0, 0, 0);
    if (at.getTime() <= now.getTime() + 30_000) continue;
    out.push({ from: r.index, to: r.index + r.text.length, text: r.text, at, hasTime });
  }
  return out;
}

/** 한국어 + 영어를 합쳐 겹치지 않게 */
export function findAllDates(text, { chrono = null, now = new Date() } = {}) {
  const ko = findDates(text, now);
  const en = findEnglishDates(text, chrono, now).filter((e) => !ko.some((k) => e.from < k.to && e.to > k.from));
  return [...ko, ...en].sort((a, b) => a.from - b.from);
}
