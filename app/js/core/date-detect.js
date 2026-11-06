// 글 속의 날짜·시각 찾기 — "내일 오후 3시", "다음 주 화요일", "10월 12일 14:30", "이틀 뒤", "세 시 반" 같은 말을 찾아
// 그 시각(Date)으로. 편집기는 찾은 자리에 밑줄을 긋고, 누르면 그 시각에 알림을 맞춘다 (순수 함수, 단위 테스트 대상).
//   한국어는 직접(오픈소스 날짜 해석기 chrono 에 한국어가 없음), 영어는 chrono(MIT)를 넘겨받아 쓴다.
//   앞으로의 시각만 — 지난 날("어제 오후 3시", "지난 금요일")은 그 자리를 통째로 비워 둔다(뒤의 "3시"를 오늘로 잘못 읽지 않게).
//
// 읽는 차례: ① 날짜 말(날짜 + 바로 뒤의 시각) ② 날짜 없이 시각만 (①이 차지한 자리는 건너뜀)
//   날짜 뒤 시각:  오후 3시 · 3시 반 · 3시 20분 · 15:30 · 세 시 · 열한 시 반 · 저녁(시각 없이 때만: 19시)
//   시각만:        오전·오후 없는 1~6시는 오후, 7~11시는 오전. 이미 지났으면 찾지 않음 (새벽·자정은 다음 날로)

import { startOfDay, addDays, WEEKDAY as WEEKDAYS } from './time.js';

// 하루·한 주 뒤는 달력으로 더한다 (서머타임이 바뀌는 날에도 같은 시각이 되게)
const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
export const DEFAULT_HOUR = 9; // 날짜만 적었으면 그날 아침 9시

// 앞이 숫자·영문이면 다른 말의 일부 ("2026년" 의 "26년" 같은)
const NOT_AFTER = '(?<![0-9A-Za-z])';
const NOT_AFTER_HANGUL = '(?<![가-힣])';

// 고유어 시각 (한 시 ~ 열두 시) — 긴 것부터
const NATIVE_HOURS = { 열한: 11, 열두: 12, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 한: 1, 두: 2, 세: 3, 네: 4, 열: 10 };
const NATIVE_HOUR_RE = '열한|열두|다섯|여섯|일곱|여덟|아홉|한|두|세|네|열';
// 고유어 개수 (한 달 · 두 시간 · 세 주)
const NATIVE_COUNT = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const COUNT_RE = '\\d{1,3}|열|다섯|여섯|일곱|여덟|아홉|한|두|세|네';
// 날 수 고유어
const NATIVE_DAYS = { 하루: 1, 이틀: 2, 사흘: 3, 나흘: 4, 닷새: 5, 엿새: 6, 이레: 7, 여드레: 8, 아흐레: 9, 열흘: 10 };
// 한자어 수 (분: 십오 분 · 삼십 분)
const SINO = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
function sinoNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let digit = 0;
  for (const ch of text) {
    if (ch === '십') {
      total += (digit || 1) * 10;
      digit = 0;
    } else if (ch in SINO) digit = SINO[ch];
    else return NaN;
  }
  return total + digit;
}
const count = (text) => (/^\d+$/.test(text) ? Number(text) : NATIVE_COUNT[text] ?? NaN);

// 때를 나타내는 말과, 시각 없이 쓰였을 때의 시각
const PERIOD_HOUR = { 새벽: 6, 아침: 8, 오전: 9, 점심: 12, 낮: 13, 오후: 14, 저녁: 19, 밤: 21 };
const PERIOD_RE = '오전|오후|아침|점심|저녁|밤|낮|새벽';

const ymd = (d) => ({ y: d.getFullYear(), mo: d.getMonth(), d: d.getDate() });
const weekdayIndex = (ch) => WEEKDAYS.indexOf(ch);
const atTime = (date, t) => new Date(date.y, date.mo, date.d, t.h, t.min);
const validDay = (date) => {
  const d = new Date(date.y, date.mo, date.d);
  return d.getFullYear() === date.y && d.getMonth() === date.mo && d.getDate() === date.d;
};

// 이번 주 = 월요일에 시작하는 주 (한국 달력 관례)
function weekdayIn(now, weekOffset, wd) {
  const today = startOfDay(now);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  return addDays(monday, weekOffset * 7 + ((wd + 6) % 7));
}

function withYear(year, mo, d, now) {
  if (year) return { y: year, mo, d };
  // 연도가 없으면 올해 — 이미 지났으면 내년 (12월에 적은 "1월 3일")
  const thisYear = new Date(now.getFullYear(), mo, d, 23, 59);
  return { y: thisYear < now ? now.getFullYear() + 1 : now.getFullYear(), mo, d };
}

const WEEK_OFFSET = { 이번: 0, 이번주: 0, 다음: 1, 담: 1, 다다음: 2, 지난: -1, 저번: -1 };

// ---------- 날짜 말 ----------
// date(m, now) → { date: {y, mo, d} } | { at: Date, hasTime: true } (시각까지 정해지는 상대 표현) | null
// needsMore: 뒤에 요일 괄호나 시각이 있을 때만 날짜로 (분수·소수와 헷갈리지 않게)
// rollWeek: 요일만 적은 말 — 그 시각이 지났으면 다음 주
// noTime: 날짜만 (뒤 시각을 읽지 않음)
const DATE_RULES = [
  // 매년 M월 D일 (되풀이 — "M월 D일" 보다 먼저)
  {
    re: /(?<![가-힣])매년\s?(\d{1,2})월\s?(\d{1,2})일/g,
    // 2월 29일은 평년엔 28일에 (반복 알림 코어와 같은 규칙) — 4월 31일처럼 어느 해에도 없는 날만 버린다
    date: (m, now) => {
      const mo = +m[1] - 1;
      const day = +m[2];
      if (mo < 0 || mo > 11 || day < 1 || day > new Date(2000, mo + 1, 0).getDate()) return { date: { y: now.getFullYear(), mo, d: day } };
      const y = now.getFullYear();
      return { date: { y, mo, d: Math.min(day, new Date(y, mo + 1, 0).getDate()) }, repeat: { every: 'year', month: +m[1], day } };
    },
  },
  // 2026-10-12, 2026.10.12, 2026/10/12
  {
    re: new RegExp(`${NOT_AFTER}(\\d{4})[-./]\\s?(\\d{1,2})[-./]\\s?(\\d{1,2})(?![0-9])\\.?`, 'g'),
    date: (m) => ({ date: { y: +m[1], mo: +m[2] - 1, d: +m[3] } }),
  },
  // (2026년) 10월 12일 · 26년 10월 12일
  {
    re: new RegExp(`${NOT_AFTER}(?:(\\d{4}|\\d{2})년\\s?)?(\\d{1,2})월\\s?(\\d{1,2})일`, 'g'),
    date: (m, now) => ({ date: withYear(m[1] ? (m[1].length === 2 ? 2000 + +m[1] : +m[1]) : null, +m[2] - 1, +m[3], now) }),
  },
  // '26.10.20 · 26.10.20 (두 자리 연도)
  {
    re: /(?<![0-9A-Za-z.])'?(\d{2})\.(\d{1,2})\.(\d{1,2})(?![0-9.])/g,
    date: (m) => ({ date: { y: 2000 + +m[1], mo: +m[2] - 1, d: +m[3] } }),
  },
  // 10/12 · 10.12 — 뒤에 요일 괄호나 시각이 있을 때만 ("1/2 컵", "3.5" 는 날짜가 아님)
  {
    re: /(?<![0-9A-Za-z/.])(\d{1,2})[/.](\d{1,2})(?![0-9/.])/g,
    date: (m, now) => ({ date: withYear(null, +m[1] - 1, +m[2], now) }),
    needsMore: true,
  },
  // 이번 달 20일 · 다음 달 3일 · 다다음 달 1일
  {
    re: /(?<![가-힣])(이번|다음|다다음)\s?달\s?(\d{1,2})일/g,
    date: (m, now) => {
      const first = new Date(now.getFullYear(), now.getMonth() + { 이번: 0, 다음: 1, 다다음: 2 }[m[1]], 1);
      return { date: { y: first.getFullYear(), mo: first.getMonth(), d: +m[2] } };
    },
  },
  // 크리스마스(이브)
  {
    re: /(?<![가-힣])크리스마스(\s?이브)?/g,
    date: (m, now) => ({ date: withYear(null, 11, m[1] ? 24 : 25, now) }),
  },
  // 지난 날: 어제 · 그제 · 그저께 · 엊그제 · 어젯밤 — 자리만 차지 (뒤 시각을 오늘로 읽지 않게)
  {
    re: /(?<![가-힣])(어제|어젯밤|그제|그저께|엊그제|지난밤)/g,
    date: (_m, now) => ({ date: ymd(addDays(now, -1)), past: true }),
  },
  // 오늘 · 내일 · 낼 · 모레 · 내일모레 · 글피
  {
    // "낼" 은 "내다" (돈을 낼게요·낼 사람) 와 같아 시각·때가 바로 이어질 때만 ("낼 3시", "낼 아침")
    re: new RegExp(`(?<![가-힣])(오늘|내일\\s?모레|내일|낼(?=\\s?(?:\\d|${PERIOD_RE}|${NATIVE_HOUR_RE}\\s?시))|모레|글피)(?!의)`, 'g'),
    date: (m, now) => ({ date: ymd(addDays(now, { 오늘: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[m[1].replace(/\s/g, '')] ?? 2)), today: m[1] === '오늘' }),
  },
  // N시간 M분 뒤 · 30분 뒤 · 한 시간 후 · 30분 있다가
  {
    re: new RegExp(`(?<![0-9가-힣])(?:(${COUNT_RE})\\s?시간\\s?(반)?\\s?)?(?:(\\d{1,3}|[일이삼사오육칠팔구십]{1,3})\\s?분\\s?)?(뒤|후|있다가|이따가?)(?=$|[^가-힣]|에|엔|쯤)`, 'g'),
    date: (m, now) => {
      const hours = m[1] ? count(m[1]) : 0;
      const mins = (m[2] ? 30 : 0) + (m[3] ? sinoNumber(m[3]) : 0);
      if (!m[1] && !m[3]) return null;
      if (!(hours >= 0) || !(mins >= 0) || hours + mins === 0) return null;
      return { at: new Date(now.getTime() + (hours * 60 + mins) * 60_000) };
    },
  },
  // 하루·이틀·사흘 … 열흘 뒤
  {
    re: /(?<![가-힣])(하루|이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘)\s?(?:뒤|후|있다가|지나서)/g,
    date: (m, now) => ({ date: ymd(addDays(now, NATIVE_DAYS[m[1]])) }),
  },
  // 3일 뒤 · 일주일 후 · 2주 뒤 · 한 달 뒤 · 3개월 후 · 1년 뒤
  {
    re: new RegExp(`(?<![0-9가-힣])(?:(일)주일|(${COUNT_RE})\\s?(일|주일?|달|개월|년))\\s?(?:뒤|후|있다가|지나서)(?=$|[^가-힣]|에|엔|쯤)`, 'g'),
    date: (m, now) => {
      if (m[1]) return { date: ymd(addDays(now, 7)) };
      const n = count(m[2]);
      if (!(n > 0)) return null;
      const unit = m[3];
      if (unit === '일') return { date: ymd(addDays(now, n)) };
      if (unit.startsWith('주')) return { date: ymd(addDays(now, n * 7)) };
      const months = unit === '년' ? n * 12 : n;
      const t = new Date(now.getFullYear(), now.getMonth() + months, 1);
      const day = Math.min(now.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate());
      return { date: { y: t.getFullYear(), mo: t.getMonth(), d: day } };
    },
  },
  // ---- 되풀이: 매일 · 매주 X요일 · X요일마다 · 매달 N일 · 매년 M월 D일 → 반복 알림 (한 번짜리로 잘못 맞추지 않게) ----
  {
    re: /(?<![가-힣])매일|(?<![가-힣])날마다/g,
    date: (_m, now) => ({ date: ymd(now), repeat: { every: 'day' } }),
  },
  {
    re: new RegExp(`(?<![가-힣])매주\\s?([${WEEKDAYS}])(?:요일|욜)|(?<![가-힣])([${WEEKDAYS}])(?:요일|욜)\\s?마다`, 'g'),
    date: (m, now) => {
      const wd = weekdayIndex(m[1] ?? m[2]);
      return { date: ymd(addDays(startOfDay(now), (wd - now.getDay() + 7) % 7)), repeat: { every: 'week', weekdays: [wd] } };
    },
  },
  {
    re: /(?<![가-힣])(?:매달|매월)\s?(\d{1,2})일(?:\s?마다)?/g,
    date: (m, now) => {
      const d = +m[1];
      if (d < 1 || d > 31) return null;
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      return { date: { y: now.getFullYear(), mo: now.getMonth(), d: Math.min(d, last) }, repeat: { every: 'month', day: d } };
    },
  },
  // (이번|다음|담|다다음|지난|저번) 주 X요일 · 다음주 월욜
  {
    re: new RegExp(`(?<![가-힣])(이번|다음|담|다다음|지난|저번)\\s?주\\s?([${WEEKDAYS}])(?:요일|욜)`, 'g'),
    date: (m, now) => {
      const off = WEEK_OFFSET[m[1]];
      return { date: ymd(weekdayIn(now, off, weekdayIndex(m[2]))), past: off < 0 };
    },
  },
  // (이번|다음) 주말 → 그 주 토요일
  {
    re: /(?<![가-힣])(?:(이번|다음|담|다다음|지난|저번)\s?)?주말/g,
    date: (m, now) => {
      const off = WEEK_OFFSET[m[1] ?? '이번'];
      let sat = weekdayIn(now, off, 6);
      // 이번 주말인데 토요일 아침이 지났으면 일요일, 주말이 다 지났으면 ("주말" 만 적은 것은) 다음 주말
      if (off === 0 && new Date(sat.getTime() + DEFAULT_HOUR * 3_600_000) <= now) {
        const sun = addDays(sat, 1);
        if (new Date(sun.getTime() + DEFAULT_HOUR * 3_600_000) > now) sat = sun;
        else if (!m[1]) sat = addDays(sat, 7);
      }
      return { date: ymd(sat), past: off < 0 };
    },
  },
  // X요일 · X욜 → 오늘부터 가장 가까운 그 요일 (오늘이 그 요일이면 오늘)
  {
    re: new RegExp(`(?<![가-힣])([${WEEKDAYS}])(?:요일|욜)`, 'g'),
    date: (m, now) => ({ date: ymd(addDays(startOfDay(now), (weekdayIndex(m[1]) - now.getDay() + 7) % 7)), rollWeek: true }),
  },
  // 15일까지 · 25일에 — 이번 달(지났으면 다음 달). "3일 동안" · "3일에 걸쳐" · "1일 1식" 은 날짜가 아님
  {
    re: /(?<![0-9가-힣./-])(\d{1,2})일(?=\s?(?:까지|에(?!\s?걸쳐)|부터|날|\(|오전|오후|아침|점심|저녁|밤|낮|새벽|\d{1,2}\s?시|\d{1,2}:|\d{1,2}\s?(?:am|pm|AM|PM)\b))/g, // 줄 끝·문장부호 앞의 "3일" 은 기간("휴가 3일")일 때가 많아 날짜로 읽지 않음
    date: (m, now) => {
      const d = +m[1];
      if (d < 1 || d > 31) return null;
      let date = { y: now.getFullYear(), mo: now.getMonth(), d };
      // 이번 달이 지났으면 다음 달 — 다음 달에 그날이 없으면(1월 31일의 "30일까지") 어느 달인지 알 수 없어 찾지 않는다(아래 validDay)
      if (new Date(date.y, date.mo, d, 23, 59) < now || !validDay(date)) {
        const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        date = { y: next.getFullYear(), mo: next.getMonth(), d };
      }
      return { date };
    },
  },
];

// ---------- 시각 ----------
// 오후 3시 · 3시 반 · 3시 20분 · 세 시 · 열한 시 반 · 15:30 · 오후 3:30 · 정오 · 자정
// "시" 뒤에 시간·시작·시험 같은 다른 말이 오면 시각이 아니다
const AFTER_SI = '(?!\\s?방향)(?=$|[^가-힣]|반|에|엔|까지|부터|쯤|경|정각|전|에서|으로|이나|이고|이요|이에요|입니다)';
const MIN_RE = '(\\d{1,2}|[일이삼사오육칠팔구십]{1,3})\\s?분';
const TIME_RE = new RegExp(
  `(?:(${PERIOD_RE})\\s?)?(?:`
    + `${NOT_AFTER}(\\d{1,2}):(\\d{2})(?![0-9:])` // 15:30
    + `|${NOT_AFTER}(\\d{1,2})\\s?시(?:\\s?(반)|\\s?${MIN_RE})?${AFTER_SI}` // 3시 · 3시 반 · 3시 20분
    + `|(?:(?<=${PERIOD_RE}\\s?)|${NOT_AFTER_HANGUL})(${NATIVE_HOUR_RE})\\s?시(?:\\s?(반)|\\s?${MIN_RE})?${AFTER_SI}` // 세 시 · 열한 시 반
    + `)`
    + `|${NOT_AFTER_HANGUL}(정오|자정)`,
  'g',
);
// 때만 (시각 없이): 날짜 바로 뒤에서만 읽는다 ("내일 저녁")
// 때 말 뒤에 붙어도 되는 토씨만 ("저녁에", "아침부터") — "낮잠" · "밤샘" · "아침밥" 처럼 다른 낱말이면 때가 아님
const PERIOD_TAIL = '(?:에는|에도|에|엔|쯤에?|께|부터|까지|즈음|경|중|이나|은|는|이|의)?(?![가-힣])';
const PERIOD_ONLY_RE = new RegExp(`(${PERIOD_RE})(?=${PERIOD_TAIL})(?!\\s?(?:\\d|${NATIVE_HOUR_RE})\\s?시)`, 'y');

function timeOf(m) {
  if (m[10]) return m[10] === '정오' ? { h: 12, min: 0, explicit: true } : { h: 24, min: 0, explicit: true, midnight: true };
  const period = m[1];
  let h;
  let min;
  let digital = false;
  if (m[2] !== undefined) {
    h = +m[2];
    min = +m[3];
    digital = true;
  } else if (m[4] !== undefined) {
    h = +m[4];
    min = m[5] ? 30 : m[6] !== undefined ? sinoNumber(m[6]) : 0;
  } else {
    h = NATIVE_HOURS[m[7]];
    min = m[8] ? 30 : m[9] !== undefined ? sinoNumber(m[9]) : 0;
    // "세시 풍속" · "한시 바삐" 같은 낱말은 시각이 아님
    if (!period && /^\s?(?:풍속|바삐|바쁘)/.test(m.input.slice(m.index + m[0].length))) return null;
  }
  if (!(h >= 0) || h > 24 || !(min >= 0) || min > 59) return null;
  if (period === '오전' || period === '아침' || period === '새벽') {
    if (h === 12) h = 0;
    if (h > 12) return null;
  } else if (period) {
    if (h > 12) return null;
    if (period === '밤' && h === 12) h = 24; // 밤 12시 = 그날 자정
    else if (period === '낮' || period === '점심') h = h <= 6 ? h + 12 : h; // 낮 1시 = 13시, 낮 11시 = 11시
    else if (period === '밤' && h <= 4) h += 24; // 밤 1시 = 다음 날 새벽 1시
    else if (h < 12) h += 12;
  } else if (!digital && h >= 1 && h <= 6) {
    h += 12; // "3시 회의" 처럼 오전·오후 없이 1~6시는 보통 오후
  }
  return { h, min, period: period ?? null, digital, explicit: true };
}

const GAP_RE = /(?:\s|에\s?|의\s?|,\s?|\([월화수목금토일](?:요일)?\)\s?)*/y;

/** pos 부터 시각(또는 때만)이 바로 이어지면 { h, min, end } */
function timeAt(text, pos, { periodOnly = true } = {}) {
  GAP_RE.lastIndex = pos;
  const gap = GAP_RE.exec(text)?.[0].length ?? 0;
  const from = pos + gap;
  TIME_RE.lastIndex = from;
  const m = TIME_RE.exec(text);
  if (m && m.index === from) {
    const t = timeOf(m);
    if (t) return { ...t, end: rangeEnd(text, m.index + m[0].length) };
  }
  if (!periodOnly) return null;
  PERIOD_ONLY_RE.lastIndex = from;
  const p = PERIOD_ONLY_RE.exec(text);
  return p ? { h: PERIOD_HOUR[p[1]], min: 0, period: p[1], explicit: false, end: from + p[0].length } : null;
}

/** "3시~5시" · "3시부터 5시까지": 끝 시각까지 한 자리로 (알림은 시작 시각) */
function rangeEnd(text, end) {
  const r = /^\s?(?:~|-|–|부터)\s?/.exec(text.slice(end));
  if (!r) return end;
  TIME_RE.lastIndex = end + r[0].length;
  const m = TIME_RE.exec(text);
  if (!m || m.index !== end + r[0].length) return end;
  const tail = /^\s?까지/.exec(text.slice(m.index + m[0].length));
  return m.index + m[0].length + (tail ? tail[0].length : 0);
}

/** 되풀이 알림의 다음 차례 (이미 지났으면 하루·한 주·한 달·한 해 뒤로) */
function nextRepeat(at, repeat, now) {
  let next = at;
  for (let i = 0; i < 400 && next <= now; i++) {
    if (repeat.every === 'day') next = plusDays(next, 1);
    else if (repeat.every === 'week') next = plusDays(next, 7);
    else {
      const months = repeat.every === 'year' ? 12 : 1;
      const base = new Date(next.getFullYear(), next.getMonth() + months, 1, next.getHours(), next.getMinutes());
      const last = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      next = new Date(base.getFullYear(), base.getMonth(), Math.min(repeat.day ?? next.getDate(), last), next.getHours(), next.getMinutes());
    }
  }
  return next;
}

/**
 * 글 속 날짜·시각들 (앞에서부터, 겹치지 않게)
 * @param {string} text 한 줄(문단)의 글
 * @param {Date} [now]
 * @returns {{ from: number, to: number, text: string, at: Date, hasTime: boolean, repeat?: { every: 'day'|'week'|'month'|'year', weekdays?: number[], day?: number, month?: number, time: string } }[]}
 */
export function findDates(text, now = new Date(), { allowPast = false } = {}) {
  const s = String(text ?? '');
  const found = [];
  const taken = []; // 날짜 말이 차지한 자리 (지난 날 포함)
  const overlaps = (from, to) => taken.some((r) => from < r.to && to > r.from);
  const add = (from, to, at, hasTime, { past = false, repeat = null, rollWeek = false } = {}) => {
    if (overlaps(from, to)) return;
    const span = { from, to };
    taken.push(span);
    if ((past && !allowPast) || !(at instanceof Date) || Number.isNaN(at.getTime())) {
      span.skipped = true; // 지난 날 — 바로 뒤의 영어 시각도 지난 때로 (findAllDates)
      return;
    }
    // 되풀이는 이미 지났으면 다음 차례로
    if (repeat) at = nextRepeat(at, repeat, now);
    if (!allowPast && at.getTime() <= now.getTime() + 30_000) return;
    const item = { from, to, text: s.slice(from, to).trim(), at, hasTime };
    // 요일만 적은 말("화요일")인지 — 영어 시각을 붙일 때 이번 주/다음 주를 다시 고른다 (findAllDates). 결과 모양에는 드러내지 않음
    if (rollWeek) Object.defineProperty(item, 'rollWeek', { value: true });
    if (repeat) item.repeat = { ...repeat, time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` };
    found.push(item);
  };

  for (const rule of DATE_RULES) {
    rule.re.lastIndex = 0;
    for (const m of s.matchAll(rule.re)) {
      const from = m.index;
      let to = from + m[0].length;
      if (overlaps(from, to)) continue;
      const paren = /^\s?\((?:[월화수목금토일](?:요일)?)\)/.exec(s.slice(to));
      if (paren) to += paren[0].length;
      const r = rule.date(m, now);
      if (!r) continue;
      if (r.at) {
        add(from, to, r.at, true);
        continue;
      }
      const date = r.date;
      if (!date || date.mo < 0 || date.mo > 11 || !validDay(date)) {
        taken.push({ from, to }); // "13월 1일" 의 "1일" 을 따로 날짜로 읽지 않게
        continue;
      }
      // "지난 금요일" · "저번 주 화요일" 처럼 앞에 지난 말이 붙은 요일도 지난 날
      const pastWord = /(지난|저번)\s?(주\s?)?$/.test(s.slice(Math.max(0, from - 5), from));
      const past = r.past || pastWord;
      const t = timeAt(s, to);
      if (rule.needsMore && !paren && !(t?.explicit)) continue;
      if (t) {
        let at = atTime(date, t);
        if ((rule.rollWeek || r.rollWeek) && at <= now) at = plusDays(at, 7);
        add(from, t.end, at, true, { past, repeat: r.repeat, rollWeek: Boolean(rule.rollWeek || r.rollWeek) });
      } else if (r.today) {
        taken.push({ from, to }); // "오늘" 만은 알림 시각이 없다
      } else {
        let at = atTime(date, { h: DEFAULT_HOUR, min: 0 });
        // 오늘이 그 요일이고 9시가 지났으면: 날짜만 적은 "금요일" 은 다음 주
        if ((rule.rollWeek || r.rollWeek) && at <= now) at = plusDays(at, 7);
        add(from, to, at, false, { past, repeat: r.repeat, rollWeek: Boolean(rule.rollWeek || r.rollWeek) });
      }
    }
  }

  // 날짜 없이 시각만: 오늘 그 시각 (지났으면 찾지 않음 — 다만 새벽·자정은 다음 날)
  TIME_RE.lastIndex = 0;
  for (const m of s.matchAll(TIME_RE)) {
    const from = m.index;
    if (overlaps(from, from + m[0].length)) continue;
    const t = timeOf(m);
    if (!t) continue;
    // 오전·오후 없는 숫자 시각(12:30)은 시간표·기록일 때가 많고, "24시 편의점" 은 시각이 아니다
    if (t.digital && !t.period) continue;
    if (!t.period && t.h === 24 && !t.midnight) continue;
    const end = rangeEnd(s, from + m[0].length);
    let at = atTime(ymd(now), t);
    if (!allowPast && at <= now && (t.period === '새벽' || t.midnight)) at = plusDays(at, 1);
    add(from, end, at, true);
  }

  const result = found.sort((a, b) => a.from - b.from);
  Object.defineProperty(result, 'skipped', { value: taken.filter((t) => t.skipped) }); // 지난 날로 읽고 버린 자리
  return result;
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
export function findAllDates(text, { chrono = null, now = new Date(), allowPast = false } = {}) {
  const ko = findDates(text, now, { allowPast });
  const s = String(text ?? '');
  // 한국어 날짜와 겹치거나, 지난 날 말 바로 뒤에 붙은 영어 시각("어제 3pm")은 빼고
  const afterPast = (e) => (ko.skipped ?? []).some((k) => (e.from < k.to && e.to > k.from) || (k.to <= e.from && !s.slice(k.to, e.from).trim()));
  const en = findEnglishDates(text, chrono, now).filter((e) => !ko.some((k) => e.from < k.to && e.to > k.from) && !afterPast(e));
  // 한국어 날 말 바로 뒤의 영어 시각("내일 3pm")은 그날 그 시각 하나로 (오늘 3pm 을 따로 만들지 않게)
  for (let i = en.length - 1; i >= 0; i--) {
    const e = en[i];
    if (!e.hasTime) continue;
    const k = ko.find((x) => x.to <= e.from && !s.slice(x.to, e.from).trim());
    if (!k) continue;
    en.splice(i, 1);
    if (k.hasTime) continue; // 이미 시각이 있으면 영어 쪽만 버린다
    if (k.repeat) {
      // 되풀이("매일 3pm"): 되풀이 시각을 영어 시각으로 (지났으면 다음 차례)
      let at = new Date(k.at.getFullYear(), k.at.getMonth(), k.at.getDate(), e.at.getHours(), e.at.getMinutes());
      // 기본 9시가 지나 다음 차례로 넘겼던 것을, 새 시각이면 아직인 이번 차례로 되돌린다 ("매일 3pm" 을 오전 10시에 = 오늘 3시)
      const step = { day: 1, week: 7 }[k.repeat.every];
      while (step && plusDays(at, -step) > now) at = plusDays(at, -step);
      if (k.repeat.every === 'month' || k.repeat.every === 'year') {
        // 매달·매년: 이번 차례(이번 달·올해 그날)부터 다시 — 기본 9시가 지나 다음 차례로 넘겼던 것을 되돌림
        const mo = k.repeat.every === 'year' ? k.repeat.month - 1 : now.getMonth();
        const dim = new Date(now.getFullYear(), mo + 1, 0).getDate();
        at = new Date(now.getFullYear(), mo, Math.min(k.repeat.day, dim), at.getHours(), at.getMinutes());
      }
      at = nextRepeat(at, k.repeat, now);
      k.at = at;
      k.repeat = { ...k.repeat, time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` };
      k.to = e.to;
      k.text = s.slice(k.from, e.to).trim();
      k.hasTime = true;
      continue;
    }
    let at = new Date(k.at.getFullYear(), k.at.getMonth(), k.at.getDate(), e.at.getHours(), e.at.getMinutes());
    // 요일 말("일요일 3pm"): 날짜만으로 다음 주로 넘겼어도 이번 그 시각이 아직이면 이번 주로, 지났으면 다음 주로 (한국어 시각과 같은 규칙)
    const weekday = Boolean(k.rollWeek); // 요일만 적은 말 ("다음 주 화요일"·"10월 30일 (금요일)" 은 아님)
    if (weekday && plusDays(at, -7) > now) at = plusDays(at, -7);
    if (at.getTime() <= now.getTime() + 30_000) {
      if (weekday) at = plusDays(at, 7);
      else {
        ko.splice(ko.indexOf(k), 1); // 그 시각이 이미 지났다 — 일정으로 보이지 않게
        continue;
      }
    }
    k.at = at;
    k.to = e.to;
    k.text = s.slice(k.from, e.to).trim();
    k.hasTime = true;
  }
  return [...ko, ...en].sort((a, b) => a.from - b.from);
}

/** 첫 줄의 첫 날짜로 맞출 알림 (매직키 "알림 맞춰 저장" · MagicKey --remind) — 날짜가 없으면 null */
export function remindFromText(text, now = new Date()) {
  const line = String(text ?? '').split('\n')[0];
  const w = findDates(line, now)[0];
  return w ? { at: w.at.toISOString(), hasTime: w.hasTime, repeat: w.repeat ?? null, title: guessTitle(line, w.from, w.to) } : null;
}

/** 일정 이름 짐작: 그 줄에서 날짜 말을 빼고 남은 말 ("내일 오후 3시 치과" → "치과", "15일까지 보고서 제출" → "보고서 제출") */
export function guessTitle(line, from, to) {
  const rest = `${line.slice(0, from)} ${line.slice(to)}`
    .replace(/\uFFFC/g, ' ')
    .replace(/^\s*(?:까지|에는|에|부터|은|는|이|가|의|쯤|경)(?=\s|$)/, '')
    .replace(/(?:^|\s)(?:까지|에는|에|부터)(?=\s)/g, ' ')
    .replace(/[\s,:·\-–~]+$/, '')
    .replace(/^[\s,:·\-–~]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return rest.slice(0, 40);
}
