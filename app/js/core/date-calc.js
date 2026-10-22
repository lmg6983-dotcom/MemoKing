// 매직키 날짜 계산 (순수 함수, 단위 테스트 대상) — 인터넷 없이, 쓴 글 전체가 날짜 계산일 때만 답한다
//   (메모로 쓰는 "3일 뒤 출장 준비" 같은 글은 계산하지 않게, 앞뒤 군말 없는 식만)
//
//   오늘에서:   3주 뒤 · 100일 후 · 2달 전 · 1년 반 뒤 · 열흘 뒤 · 100일째 · D-100 · D+30 · 영업일 10일 뒤
//   날짜에서:   2026-03-01 + 100일 · 3월 1일부터 100일째 · 12/25 - 2주 · 크리스마스로부터 30일 뒤
//   남은 날:    12월 25일까지 · 12/25까지 며칠 · 크리스마스까지 몇 주 · 디데이 2027-01-01 · 금요일까지
//   지난 날:    2026-03-01부터 · 3월 1일부터 오늘까지 며칠
//   사이:       1월 1일부터 6월 30일까지 · 2026.1.1 ~ 2026.6.30 (양 끝 포함 · 주 · 달 · 영업일도)
//   요일:       12월 25일 무슨 요일 · 2027-01-01 요일 · 다음 주 금요일 · 다음 달 말일 · 2026-12-25 (날짜만 써도)
//   시각:       3시간 뒤 · 90분 후 · 1시간 반 뒤 · 오후 3시 + 2시간 · 9:15부터 18:30까지 · 14:30 - 9:15
//   나이:       만 나이 1990-05-03 · 1990년 5월 3일생 나이
//   오늘:       오늘 날짜 · 오늘 무슨 요일 · 오늘 몇 주차 · 올해 남은 날 · 이번 달 말일
//
// 결과: { value: 크게 보일 답, plain: 복사할 답, detail: 아래 작은 설명 } 또는 null
//   해가 없는 날짜는 "까지"면 다가오는 날(지났으면 내년), "부터"면 지나간 날(아직이면 작년), 그 밖은 올해
//   달을 더해 없는 날이 되면 그 달 말일 (1월 31일 + 1달 → 2월 28일), 영업일은 토 · 일과 양력 공휴일만 뺌

import { WEEKDAY, pad2 } from './time.js';

const DAY = 86_400_000;
const dayNum = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
const mk = (y, m, d) => new Date(y, m, d);
const today0 = (now) => mk(now.getFullYear(), now.getMonth(), now.getDate());
const addD = (d, n) => mk(d.getFullYear(), d.getMonth(), d.getDate() + n);
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
const valid = (y, m, d) => m >= 0 && m <= 11 && d >= 1 && d <= lastDay(y, m);
const diff = (a, b) => dayNum(b) - dayNum(a);

/** 달 · 해 더하기 — 없는 날이면 그 달 말일 (clamped: 말일로 바꿨는가) */
function addMonths(d, n) {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const day = Math.min(d.getDate(), lastDay(ty, tm));
  return { date: mk(ty, tm, day), clamped: day !== d.getDate() };
}

// ---------- 공휴일 (양력만 — 설 · 추석 · 부처님오신날 · 대체공휴일은 해마다 달라 빼지 않는다) ----------
const SOLAR_HOLIDAYS = ['1-1', '3-1', '5-5', '6-6', '8-15', '10-3', '10-9', '12-25'];
const isOff = (d) => d.getDay() === 0 || d.getDay() === 6 || SOLAR_HOLIDAYS.includes(`${d.getMonth() + 1}-${d.getDate()}`);
function addBusinessDays(d, n) {
  let cur = d;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    cur = addD(cur, step);
    if (!isOff(cur)) left--;
  }
  return cur;
}
function businessDaysBetween(a, b) {
  let n = 0;
  for (let cur = addD(a, 1); dayNum(cur) <= dayNum(b); cur = addD(cur, 1)) if (!isOff(cur)) n++;
  return n;
}

// 이름 있는 날 (양력, 해마다 같은 날)
const NAMED_DAYS = {
  크리스마스: [12, 25], 성탄절: [12, 25], 새해: [1, 1], 신정: [1, 1], 삼일절: [3, 1], 어린이날: [5, 5], 어버이날: [5, 8],
  스승의날: [5, 15], 현충일: [6, 6], 제헌절: [7, 17], 광복절: [8, 15], 개천절: [10, 3], 한글날: [10, 9],
  발렌타인데이: [2, 14], 밸런타인데이: [2, 14], 화이트데이: [3, 14], 빼빼로데이: [11, 11], 할로윈: [10, 31], 핼러윈: [10, 31],
};
const NAMED_RE = Object.keys(NAMED_DAYS).sort((a, b) => b.length - a.length).join('|');

// ---------- 날짜 말 ----------
const NATIVE = { 한: 1, 두: 2, 세: 3, 석: 3, 네: 4, 넉: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
const NATIVE_DAYS = { 하루: 1, 이틀: 2, 사흘: 3, 나흘: 4, 닷새: 5, 엿새: 6, 이레: 7, 여드레: 8, 아흐레: 9, 열흘: 10, 보름: 15 };
const RELATIVE_DAY = { 그끄저께: -3, 그저께: -2, 그제: -2, 어제: -1, 오늘: 0, 지금: 0, 내일: 1, 모레: 2, 글피: 3, 그글피: 4 };
const WEEK_OFFSET = { 지지난: -2, 지난: -1, 저번: -1, 이번: 0, 금: 0, 다음: 1, 담: 1, 다다음: 2 };
const YEAR_OFFSET = { 재작년: -2, 작년: -1, 지난해: -1, 올해: 0, 금년: 0, 내년: 1, 다음해: 1, 내후년: 2 };

/** 해 없이 쓴 달 · 날의 해 — prefer: 'future' 다가오는 날 · 'past' 지나간 날 · 'near' 올해 */
function pickYear(m, d, now, prefer) {
  const y = now.getFullYear();
  const t = today0(now);
  if (!valid(y, m, d) && !(m === 1 && d === 29)) return null;
  const tryYear = (yy) => (valid(yy, m, d) ? mk(yy, m, d) : null);
  if (prefer === 'future') {
    for (let yy = y; yy <= y + 8; yy++) {
      const c = tryYear(yy);
      if (c && dayNum(c) >= dayNum(t)) return c;
    }
    return null;
  }
  if (prefer === 'past') {
    for (let yy = y; yy >= y - 8; yy--) {
      const c = tryYear(yy);
      if (c && dayNum(c) <= dayNum(t)) return c;
    }
    return null;
  }
  return tryYear(y) ?? tryYear(y + 1);
}

const fullYear = (yy) => (yy.length === 2 ? 2000 + Number(yy) : Number(yy));

/**
 * 날짜 말 하나 → { date, explicitYear } 또는 null. 앞뒤 띄어쓰기는 이미 정리됨
 */
export function parseDay(raw, now = new Date(), prefer = 'near') {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const t = today0(now);
  let m;
  if (s in RELATIVE_DAY) return { date: addD(t, RELATIVE_DAY[s]), relative: true };
  // 2026-12-25 · 2026.12.25 · 2026/12/25 · 2026. 12. 25. · 26.12.25
  if ((m = s.match(/^(\d{4}|\d{2})\s*([-./])\s*(\d{1,2})\s*\2\s*(\d{1,2})\.?$/))) {
    const y = fullYear(m[1]);
    const mo = Number(m[3]) - 1;
    const d = Number(m[4]);
    return valid(y, mo, d) ? { date: mk(y, mo, d), explicitYear: true } : null;
  }
  // 2026년 12월 25일 · 올해 12월 25일 · 내년 3월 1일 · 2027년 1월 (1일)
  if ((m = s.match(new RegExp(`^(?:(\\d{2,4})\\s*년|(${Object.keys(YEAR_OFFSET).join('|')}))\\s*(\\d{1,2})\\s*월(?:\\s*(\\d{1,2})\\s*일|\\s*(말일?|말))?$`)))) {
    const y = m[1] ? fullYear(m[1]) : now.getFullYear() + YEAR_OFFSET[m[2]];
    const mo = Number(m[3]) - 1;
    if (mo < 0 || mo > 11) return null;
    const d = m[5] ? lastDay(y, mo) : m[4] ? Number(m[4]) : 1;
    return valid(y, mo, d) ? { date: mk(y, mo, d), explicitYear: true } : null;
  }
  // 12월 25일 · 12월 말일
  if ((m = s.match(/^(\d{1,2})\s*월\s*(?:(\d{1,2})\s*일|(말일?|말))$/))) {
    const mo = Number(m[1]) - 1;
    if (mo < 0 || mo > 11) return null;
    if (m[3]) {
      const y = pickYear(mo, 1, now, prefer)?.getFullYear() ?? now.getFullYear();
      return { date: mk(y, mo, lastDay(y, mo)) };
    }
    const date = pickYear(mo, Number(m[2]), now, prefer);
    return date ? { date } : null;
  }
  // 12/25 · 12.25 · 12-25 (해 없이) — 계산식과 겹치지 않게 날짜 계산 안에서만
  if ((m = s.match(/^(\d{1,2})\s*([-./])\s*(\d{1,2})$/))) {
    const date = pickYear(Number(m[1]) - 1, Number(m[3]), now, prefer);
    return date ? { date } : null;
  }
  // 크리스마스 · 올해 크리스마스 · 내년 어린이날
  if ((m = s.match(new RegExp(`^(?:(${Object.keys(YEAR_OFFSET).join('|')})\\s*)?(${NAMED_RE})$`)))) {
    const [mo, d] = NAMED_DAYS[m[2]];
    if (m[1]) return { date: mk(now.getFullYear() + YEAR_OFFSET[m[1]], mo - 1, d), explicitYear: true };
    return { date: pickYear(mo - 1, d, now, prefer) };
  }
  // 이번 달 말일 · 다음 달 15일 · 지난달 1일 · 이번 달 말
  if ((m = s.match(/^(이번|이|금|다음|담|다다음|지난|저번)\s*달\s*(?:(\d{1,2})\s*일|(말일?|말|초))$/))) {
    const off = { 이번: 0, 이: 0, 금: 0, 다음: 1, 담: 1, 다다음: 2, 지난: -1, 저번: -1 }[m[1]];
    const base = new Date(now.getFullYear(), now.getMonth() + off, 1);
    const y = base.getFullYear();
    const mo = base.getMonth();
    const d = m[3] ? (m[3] === '초' ? 1 : lastDay(y, mo)) : Number(m[2]);
    return valid(y, mo, d) ? { date: mk(y, mo, d) } : null;
  }
  // 25일 (이번 달)
  if ((m = s.match(/^(\d{1,2})\s*일$/))) {
    const d = Number(m[1]);
    return valid(now.getFullYear(), now.getMonth(), d) ? { date: mk(now.getFullYear(), now.getMonth(), d) } : null;
  }
  // 2주 뒤 금요일 · 3주 후 월요일 (그 주의 그 요일)
  if ((m = s.match(/^(\d{1,2}|한|두|세|네)\s*주\s*(?:뒤|후)\s*([일월화수목금토])(?:요일)?$/))) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : NATIVE[m[1]];
    const monday = addD(t, -((t.getDay() + 6) % 7));
    return { date: addD(monday, n * 7 + ((WEEKDAY.indexOf(m[2]) + 6) % 7)) };
  }
  // 다음 주 금요일 · 이번 주 월요일 · 지난주 금 · 금요일 (다가오는 · 지나간)
  if ((m = s.match(/^(?:(지지난|지난|저번|이번|금|다음|담|다다음)\s*주\s*)?([일월화수목금토])(?:요일)?$/))) {
    const wd = WEEKDAY.indexOf(m[2]);
    if (m[1]) {
      const monday = addD(t, -((t.getDay() + 6) % 7));
      return { date: addD(monday, WEEK_OFFSET[m[1]] * 7 + ((wd + 6) % 7)) };
    }
    const ahead = (wd - t.getDay() + 7) % 7;
    return { date: prefer === 'past' ? addD(t, -((t.getDay() - wd + 7) % 7)) : addD(t, ahead) };
  }
  return null;
}

// ---------- 기간 말 ----------
const UNIT = { 년: 'y', 해: 'y', 개월: 'mo', 달: 'mo', 주: 'w', 주일: 'w', 일: 'd', 날: 'd', 시간: 'h', 분: 'min', 초: 's',
  year: 'y', years: 'y', month: 'mo', months: 'mo', week: 'w', weeks: 'w', day: 'd', days: 'd', hour: 'h', hours: 'h', minute: 'min', minutes: 'min' };
const NUM_RE = `\\d+(?:\\.\\d+)?|${Object.keys(NATIVE).sort((a, b) => b.length - a.length).join('|')}`;
const UNIT_RE = '개월|주일|시간|years?|months?|weeks?|days?|hours?|minutes?|년|해|달|주|일|날|분|초';
const PART_RE = new RegExp(`(${NUM_RE})\\s*(${UNIT_RE})(\\s*반)?`, 'gy');

/** "1년 2개월" · "3주" · "열흘" · "1시간 반" · "반년" → { y, mo, w, d, h, min, s } 또는 null */
export function parseDuration(raw) {
  let s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const out = { y: 0, mo: 0, w: 0, d: 0, h: 0, min: 0, s: 0 };
  if (s in NATIVE_DAYS) return { ...out, d: NATIVE_DAYS[s] };
  if (s === '반년') return { ...out, mo: 6 };
  if (s === '일주일' || s === '한 주' || s === '한주') return { ...out, w: 1 };
  if (s === '이주일') return { ...out, w: 2 };
  if (s === '반나절') return { ...out, h: 6 };
  if (s === '한나절') return { ...out, h: 12 };
  s = s.toLowerCase();
  PART_RE.lastIndex = 0;
  let pos = 0;
  let any = false;
  while (pos < s.length) {
    if (s[pos] === ' ') {
      pos++;
      continue;
    }
    PART_RE.lastIndex = pos;
    const m = PART_RE.exec(s);
    if (!m) return null;
    const n = /^\d/.test(m[1]) ? Number(m[1]) : NATIVE[m[1]];
    const u = UNIT[m[2]];
    // 고유어 수는 시간 · 달 · 해에만 (한 달 · 두 시간 · 세 해) — "한 주", "열 일" 처럼 날에 붙으면 어색해도 읽는다
    if (!Number.isFinite(n)) return null;
    out[u] += n;
    if (m[3]) { // 반: 1년 반 · 2시간 반 · 3달 반 · 1주 반
      if (u === 'y') out.mo += 6;
      else if (u === 'mo') out.d += 15;
      else if (u === 'w') out.d += 3.5;
      else if (u === 'd') out.h += 12;
      else if (u === 'h') out.min += 30;
      else if (u === 'min') out.s += 30;
    }
    any = true;
    pos = m.index + m[0].length;
  }
  if (!any) return null;
  // 소수: 1.5년 · 2.5시간 → 아래 단위로
  for (const [u, down, k] of [['y', 'mo', 12], ['mo', 'd', 30], ['w', 'd', 7], ['d', 'h', 24], ['h', 'min', 60], ['min', 's', 60]]) {
    const f = out[u] - Math.trunc(out[u]);
    if (f) {
      out[u] = Math.trunc(out[u]);
      out[down] += Math.round(f * k * 1000) / 1000;
    }
  }
  return out;
}
const hasClock = (dur) => Boolean(dur.h || dur.min || dur.s);
const hasDate = (dur) => Boolean(dur.y || dur.mo || dur.w || dur.d);

function durationText(dur) {
  const parts = [];
  if (dur.y) parts.push(`${dur.y}년`);
  if (dur.mo) parts.push(`${dur.mo}개월`);
  if (dur.w) parts.push(`${dur.w}주`);
  if (dur.d) parts.push(`${Number.isInteger(dur.d) ? dur.d : dur.d.toFixed(1)}일`);
  if (dur.h) parts.push(`${dur.h}시간`);
  if (dur.min) parts.push(`${dur.min}분`);
  if (dur.s) parts.push(`${dur.s}초`);
  return parts.join(' ');
}

/** 날짜에 기간 더하기 (sign: 1 · -1) — 해 · 달은 달력으로(말일 맞춤), 주 · 날은 날 수로 */
function shiftDate(d, dur, sign) {
  const { date, clamped } = addMonths(d, sign * (dur.y * 12 + dur.mo));
  const days = sign * (dur.w * 7 + dur.d);
  return { date: addD(date, Math.trunc(days)), clamped };
}

// ---------- 시각 말 ----------
/** "오후 3시 30분" · "15:30" · "3시 반" · "정오" · "자정" → { h, min, ampm } */
export function parseClock(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  let m;
  if (s === '정오') return { h: 12, min: 0, ampm: true };
  if (s === '자정') return { h: 0, min: 0, ampm: true };
  if ((m = s.match(/^(오전|오후|새벽|아침|낮|저녁|밤)?\s*(\d{1,2}):(\d{2})$/))) {
    return withPeriod(Number(m[2]), Number(m[3]), m[1]);
  }
  if ((m = s.match(/^(오전|오후|새벽|아침|낮|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(?:(\d{1,2})\s*분|(반)))?$/))) {
    return withPeriod(Number(m[2]), m[4] ? 30 : Number(m[3] ?? 0), m[1]);
  }
  return null;
}
function withPeriod(h, min, period) {
  if (h > 24 || min > 59) return null;
  if (!period) return { h: h % 24, min, ampm: h > 12 || h === 0 };
  const pm = ['오후', '저녁', '밤'].includes(period) || (period === '낮' && h < 6);
  if (h > 12) return null;
  return { h: pm ? (h % 12) + 12 : h % 12, min, ampm: true };
}

// ---------- 보여 주기 ----------
const dayText = (d) => `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
const shortDay = (d, now) => (d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})` : dayText(d));
const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const clockText = (h, min) => `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${pad2(min)}`;
const relWord = (n) => ({ [-2]: '그저께', [-1]: '어제', 0: '오늘', 1: '내일', 2: '모레' }[n]);

/** 날 수 → "9주 1일" 처럼 (7일 이상일 때만) */
const weeksText = (n) => (Math.abs(n) >= 7 ? `${Math.floor(Math.abs(n) / 7)}주${Math.abs(n) % 7 ? ` ${Math.abs(n) % 7}일` : ''}` : '');

/** 두 날 사이 해 · 달 · 날 ("1년 2개월 3일") */
function ymdBetween(a, b) {
  let [from, to] = dayNum(a) <= dayNum(b) ? [a, b] : [b, a];
  let months = (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth();
  if (addMonths(from, months).date > to) months--;
  const mid = addMonths(from, months).date;
  const days = diff(mid, to);
  const y = Math.floor(months / 12);
  const mo = months % 12;
  return [y && `${y}년`, mo && `${mo}개월`, (days || (!y && !mo)) && `${days}일`].filter(Boolean).join(' ');
}

function dateResult(date, now, detail, extra = '') {
  const n = diff(today0(now), date);
  const rel = relWord(n) ?? (n > 0 ? `${n}일 뒤` : `${-n}일 전`);
  return { value: dayText(date), plain: isoDay(date), detail: [detail, detail.includes(rel) ? '' : `${rel}${extra}`].filter(Boolean).join(', ') };
}

function untilResult(date, now, label) {
  const n = diff(today0(now), date);
  const when = shortDay(date, now);
  if (n === 0) return { value: '오늘이에요', plain: '0', detail: `${dayText(date)}, D-day` };
  if (n > 0) {
    const w = weeksText(n);
    return { value: `${n}일 남음`, plain: String(n), detail: [`${label ? `${label} ` : ''}${when}까지`, w, `D-${n}`].filter(Boolean).join(', ') };
  }
  return { value: `${-n}일 지남`, plain: String(-n), detail: [`${label ? `${label} ` : ''}${when}`, weeksText(n), `D+${-n}`].filter(Boolean).join(', ') };
}

function rangeResult(a, b, now) {
  const [from, to] = dayNum(a) <= dayNum(b) ? [a, b] : [b, a];
  const n = diff(from, to);
  const parts = [`${shortDay(from, now)} ~ ${shortDay(to, now)}`];
  const w = weeksText(n);
  if (w) parts.push(w);
  if (n >= 28) parts.push(ymdBetween(from, to));
  parts.push(`양 끝 포함 ${n + 1}일`);
  parts.push(`영업일 ${businessDaysBetween(from, to) + (isOff(from) ? 0 : 1)}일`);
  return { value: `${n}일`, plain: String(n), detail: parts.join(', ') };
}

// ---------- 읽기 ----------
// 끝에 붙는 물음 말 (떼고 읽는다): "12월 25일까지 며칠 남았어?" · "무슨 요일이야"
//   한 글자 조사는 떼지 않는다 ("까지" 의 지 · "나이" 의 이), 은 · 는 만 (남은 · 되는 은 그대로)
const TAIL = /\s*(?:[?？!.]+|(?<![남되])(?:은|는)|이야|야|예요|이에요|인가요|일까요?|이지|이죠|죠|이냐|냐|니|입니까|인지|알려\s?줘|알려\s?주세요|계산해\s?줘|계산)$/;
function stripTail(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(TAIL, '').trim();
  } while (s !== prev && s);
  return s;
}
const ASK_WORD = '며칠|몇\\s*일|몇일|몇\\s*날|날\\s*수|일수|남은\\s*날짜|남은\\s*날|남은\\s*기간|남았어?|남았나|남음|지났어?|지났나|지남|됐어?|되었어?|흘렀어?|째|몇\\s*주|몇\\s*달|몇\\s*개월|기간|차이|며칠째|D-?day';
const ASK_DAYS = `(?:\\s*(?:${ASK_WORD}))*`; // "며칠 남았어" 처럼 여러 낱말도
const AFTER = '(?:뒤|후|있다가|지나서|이후|뒤에|후에|지난\\s*뒤|지난\\s*후)';
const BEFORE = '(?:전|이전|전에)';

/** s 를 op 가 나오는 자리마다 앞 · 뒤로 나눠 fn 에 — 처음 답이 나온 것 (2026-03-01 + 100일 의 "-" 처럼 앞쪽 기호에 속지 않게) */
function splitTry(s, opRe, fn) {
  const re = new RegExp(opRe.source, 'g');
  for (let m; (m = re.exec(s));) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const left = s.slice(0, m.index).trim();
    const right = s.slice(m.index + m[0].length).trim();
    if (left && right) {
      const r = fn(left, right, m[1] ?? m[0].trim());
      if (r) return r;
    }
  }
  return null;
}

/**
 * 쓴 글이 날짜 계산이면 { value, plain, detail }, 아니면 null
 * @param {string} text
 * @param {Date} [now]
 */
export function dateCalc(text, now = new Date()) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.includes('\n') || raw.length > 80) return null;
  const s = stripTail(raw.replace(/\s+/g, ' ').replace(/[，]/g, ','));
  if (!s) return null;
  const t = today0(now);
  let m;

  // --- 오늘 ---
  if (/^(?:오늘|지금)\s*(?:날짜|며칠|몇\s*일|몇일|무슨\s*날)$/.test(s) || /^(?:오늘|지금)\s*(?:무슨|뭔|몇)\s*요일$/.test(s)) {
    return { value: dayText(t), plain: isoDay(t), detail: `올해 ${weekNumber(t)}주차, 올해 ${diff(mk(t.getFullYear(), 0, 1), t) + 1}번째 날` };
  }
  if (/^(?:오늘|이번\s*주|지금)\s*(?:몇\s*주\s*차|몇\s*째\s*주|주차)$/.test(s)) {
    return { value: `${weekNumber(t)}주차`, plain: String(weekNumber(t)), detail: `${dayText(t)}, 월요일에 시작하는 주 (ISO)` };
  }
  if ((m = s.match(/^(올해|이번\s*달|이번\s*주)\s*(?:남은\s*날|며칠\s*남았?|남은\s*기간|몇\s*일\s*남았?)$/))) {
    const end = m[1] === '올해' ? mk(t.getFullYear(), 11, 31) : m[1].startsWith('이번 달') || m[1] === '이번달' ? mk(t.getFullYear(), t.getMonth(), lastDay(t.getFullYear(), t.getMonth())) : addD(t, (7 - t.getDay()) % 7);
    const n = diff(t, end);
    return { value: `${n}일 남음`, plain: String(n), detail: `${shortDay(end, now)}까지 (오늘 빼고), 오늘 포함 ${n + 1}일` };
  }

  // --- 나이 ---
  if ((m = s.match(/^(?:만\s*나이\s*(.+)|(.+?)\s*(?:생|태생|에\s*태어나면|출생)?\s*(?:만\s*)?나이)$/))) {
    const born = parseDay((m[1] ?? m[2]).replace(/생$/, ''), now, 'past');
    if (born && born.explicitYear) return ageResult(born.date, now);
  }

  // --- 시각: 3시간 뒤 · 오후 3시 + 2시간 · 9:15부터 18:30까지 ---
  const timeRes = clockCalc(s, now);
  if (timeRes) return timeRes;

  // --- D-100 · D+30 ---
  if ((m = s.match(/^d\s*([-+])\s*(\d{1,5})$/i))) {
    const n = Number(m[2]);
    const date = addD(t, n);
    return m[1] === '-'
      ? { value: dayText(date), plain: isoDay(date), detail: `오늘이 D-${n}이면 D-day는 ${n}일 뒤` }
      : { value: dayText(date), plain: isoDay(date), detail: `오늘을 D-day로 치면 D+${n}, ${n}일 뒤 (오늘을 1일째로 세면 ${n + 1}일째)` };
  }

  // --- 디데이: 디데이 12/25 · 12/25 디데이 · D-day 2027-01-01 ---
  if ((m = s.match(/^(?:디데이|d-?day)\s*(.+)$/i) ?? s.match(/^(.+?)\s*(?:디데이|d-?day)$/i))) {
    const d = parseDay(m[1], now, 'future');
    if (d?.date) return untilResult(d.date, now);
  }

  // --- 영업일: 영업일 10일 뒤 · 평일 5일 후 · 10영업일 뒤 · 2026-03-02부터 영업일 10일 ---
  if ((m = s.match(new RegExp(`^(?:(.+?)\\s*(?:부터|로부터|으로부터|에서)\\s*)?(?:(?:영업일|평일|근무일)\\s*(\\d{1,4})\\s*일?|(\\d{1,4})\\s*(?:영업일|평일|근무일))\\s*(${AFTER}|${BEFORE}|째)?$`)))) {
    const base = m[1] ? parseDay(m[1], now, 'near') : { date: t };
    if (base?.date) {
      const n = Number(m[2] ?? m[3]);
      const back = m[4] && new RegExp(`^${BEFORE}$`).test(m[4]);
      const nth = m[4] === '째';
      const date = addBusinessDays(nth && !isOff(base.date) ? addD(base.date, -1) : base.date, back ? -n : nth && !isOff(base.date) ? n : n);
      const from = m[1] ? `${shortDay(base.date, now)}부터` : '오늘부터';
      return { ...dateResult(date, now, `${from} 영업일 ${n}일${back ? ' 전' : nth ? '째' : ' 뒤'} (토 · 일 · 양력 공휴일 뺌)`) };
    }
  }

  // --- 사이: A부터 B까지 · A ~ B · A에서 B까지 ---
  const range = splitTry(s, /\s*(부터|에서|~|〜|–|\s-\s)\s*/, (left, right, op) => {
    const r = right.replace(new RegExp(`\\s*까지\\s*${ASK_DAYS}$`), '');
    if (r === right && !/[~〜–-]/.test(op)) return null; // "A부터 B" 는 "까지" 가 있어야 사이
    const a = parseDay(left, now, 'near');
    const b = parseDay(r, now, 'near');
    if (!a?.date || !b?.date) return null;
    // 해를 안 쓴 끝 날이 앞 날보다 앞서면 다음 해로 (11월 1일 ~ 2월 1일)
    let end = b.date;
    if (!b.explicitYear && !b.relative && dayNum(end) < dayNum(a.date)) end = mk(end.getFullYear() + 1, end.getMonth(), end.getDate());
    return rangeResult(a.date, end, now);
  });
  if (range) return range;

  // --- 날짜 ± 기간: A + 100일 · A부터 100일 뒤 · A로부터 30일 · A부터 100일째 · A - 2주 · A에서 3주 전 ---
  const shifted = splitTry(s, /\s*(\+|-|−|더하기|빼기|플러스|마이너스|부터|로부터|으로부터|에서|이후|기준)\s*/, (left, right, op) => {
    const tail = right.match(new RegExp(`^(.+?)\\s*(${AFTER}|${BEFORE}|째\\s*되는\\s*날|째\\s*날|째|되는\\s*날)?$`));
    const base = parseDay(left, now, 'near');
    const dur = tail && parseDuration(tail[1]);
    if (!base?.date || !dur || !hasDate(dur) || hasClock(dur)) return null;
    const sign = /^(\+|-|−|더하기|빼기|플러스|마이너스)$/.test(op);
    // "3월 1일부터 100일" · "오늘부터 100일" 처럼 뒤 · 째 없이 날 수만: 그날을 1일째로 센 날 (기념일 세는 법)
    const bareCount = !sign && !tail[2] && /^(부터|에서)$/.test(op);
    if (bareCount && (dur.y || dur.mo || dur.w)) return null;
    const back = sign ? /^(-|−|빼기|마이너스)$/.test(op) : Boolean(tail[2] && new RegExp(`^${BEFORE}$`).test(tail[2]));
    const nth = bareCount || Boolean(tail[2] && tail[2].startsWith('째'));
    if (nth && (dur.y || dur.mo || dur.w)) return null; // "째" 는 날 수에만
    const { date, clamped } = nth ? { date: addD(base.date, dur.d - 1), clamped: false } : shiftDate(base.date, dur, back ? -1 : 1);
    const word = nth ? `${dur.d}일째 (그날을 1일째로, ${dur.d}일 뒤는 ${shortDay(addD(base.date, dur.d), now)})` : `${durationText(dur)} ${back ? '전' : '뒤'}`;
    const from = relWord(diff(t, base.date)) ?? shortDay(base.date, now);
    return dateResult(date, now, `${from}부터 ${word}${clamped ? ', 없는 날이라 그 달 말일' : ''}`);
  });
  if (shifted) return shifted;

  // --- 남은 날 · 지난 날: B까지 며칠 · A부터 며칠 · A부터 오늘까지 ---
  if ((m = s.match(new RegExp(`^(.+?)\\s*까지\\s*${ASK_DAYS}$`)))) {
    const d = parseDay(m[1], now, 'future');
    if (d?.date) return untilResult(d.date, now, NAMED_DAYS[m[1].trim()] ? m[1].trim() : '');
  }
  if ((m = s.match(new RegExp(`^(.+?)\\s*(?:부터|로부터|으로부터|이후)\\s*(?:오늘\\s*까지\\s*)?${ASK_DAYS}$`)))) {
    const d = parseDay(m[1], now, 'past');
    if (d?.date) {
      const n = diff(d.date, t);
      if (n >= 0) {
        return { value: `${n}일 지남`, plain: String(n), detail: [`${shortDay(d.date, now)}부터 오늘까지`, weeksText(n), n >= 28 && ymdBetween(d.date, t), `그날을 1일째로 세면 오늘이 ${n + 1}일째`].filter(Boolean).join(', ') };
      }
      return untilResult(d.date, now);
    }
  }

  // --- 오늘에서: 3주 뒤 · 2달 전 · 100일째 · 열흘 뒤 ---
  if ((m = s.match(new RegExp(`^(?:(?:오늘|지금)\\s*(?:부터|로부터|으로부터|에서|기준)?\\s*)?(.+?)\\s*(${AFTER}|${BEFORE}|째|째\\s*되는\\s*날|째\\s*날)(?:\\s*(?:날짜|언제|며칠|몇\\s*일))?$`)))) {
    const dur = parseDuration(m[1]);
    if (dur && hasDate(dur) && !hasClock(dur)) {
      if (m[2].startsWith('째')) {
        if (dur.y || dur.mo || dur.w) return null;
        return dateResult(addD(t, dur.d - 1), now, `오늘을 1일째로 세면 ${dur.d}일째`);
      }
      const back = new RegExp(`^${BEFORE}$`).test(m[2]);
      const { date, clamped } = shiftDate(t, dur, back ? -1 : 1);
      return dateResult(date, now, `오늘부터 ${durationText(dur)} ${back ? '전' : '뒤'}${clamped ? ', 없는 날이라 그 달 말일' : ''}`);
    }
  }

  // --- 요일: A 무슨 요일 · A 요일 · 다음 주 금요일 · 다음 달 말일 · 2026-12-25 (날짜만) ---
  if ((m = s.match(/^(.+?)\s*(?:은|는|이|가)?\s*(?:무슨|뭔|몇)?\s*요일$/))) {
    const d = parseDay(m[1], now, 'near');
    if (d?.date) return dateResult(d.date, now, '');
    const inner = dateCalc(m[1], now); // 100일 뒤 무슨 요일 · 3주 뒤 요일
    if (inner && /^\d{4}-\d{2}-\d{2}$/.test(inner.plain)) return inner;
  }
  const only = parseDay(s, now, 'near');
  if (only?.date && !only.relative && !/^\d{1,2}\s*[-./]\s*\d{1,2}$/.test(s) && !/^\d{1,2}\s*일$/.test(s) && !/^[일월화수목금토]$/.test(s)) {
    // 날짜만 쓴 것: 그날 요일과 남은 · 지난 날 ("12/25" 같은 짧은 꼴은 나눗셈과 겹쳐 계산기에 맡김)
    return dateResult(only.date, now, '');
  }
  return null;
}

/** 올해 몇 주차 (ISO: 월요일 시작, 1월 4일이 든 주가 1주차) */
function weekNumber(d) {
  const target = mk(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = mk(target.getFullYear(), 0, 4);
  return 1 + Math.round((diff(jan4, target) - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function ageResult(born, now) {
  const t = today0(now);
  if (dayNum(born) > dayNum(t)) return null;
  let age = t.getFullYear() - born.getFullYear();
  const hadBirthday = t.getMonth() > born.getMonth() || (t.getMonth() === born.getMonth() && t.getDate() >= born.getDate());
  if (!hadBirthday) age--;
  // 2월 29일생은 평년에 2월 28일을 생일로
  const bd = (y) => (valid(y, born.getMonth(), born.getDate()) ? mk(y, born.getMonth(), born.getDate()) : mk(y, 1, 28));
  let next = bd(t.getFullYear());
  if (dayNum(next) < dayNum(t)) next = bd(t.getFullYear() + 1);
  const left = diff(t, next);
  return {
    value: `만 ${age}세`, plain: String(age),
    detail: `${dayText(born)}생, ${left ? `다음 생일까지 ${left}일` : '오늘이 생일'}, 연 나이 ${t.getFullYear() - born.getFullYear()}세, 태어난 지 ${diff(born, t)}일`,
  };
}

// 시각 계산: 3시간 뒤 · 90분 후 · 오후 3시 + 2시간 · 9:15부터 18:30까지 · 14:30 - 9:15 · 지금부터 3시간 뒤
function clockCalc(s, now) {
  let m;
  const at = (h, min) => {
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    return d;
  };
  const show = (d, detail) => {
    const days = diff(today0(now), d);
    const rel = relWord(days) ?? (days > 0 ? `${days}일 뒤` : `${-days}일 전`);
    const value = `${days ? `${rel} ` : ''}${clockText(d.getHours(), d.getMinutes())}`;
    return { value, plain: `${days ? `${isoDay(d)} ` : ''}${pad2(d.getHours())}:${pad2(d.getMinutes())}`, detail };
  };
  // 지금부터 N시간 뒤 · N분 전
  if ((m = s.match(new RegExp(`^(?:(?:지금|오늘|현재)\\s*(?:부터|로부터|에서|기준)?\\s*)?(.+?)\\s*(${AFTER}|${BEFORE})$`)))) {
    const dur = parseDuration(m[1]);
    if (dur && hasClock(dur) && !dur.y && !dur.mo) {
      const sign = new RegExp(`^${BEFORE}$`).test(m[2]) ? -1 : 1;
      const ms = ((dur.w * 7 + dur.d) * 1440 + dur.h * 60 + dur.min) * 60_000 + dur.s * 1000;
      const d = new Date(now.getTime() + sign * ms);
      return show(d, `지금(${clockText(now.getHours(), now.getMinutes())})부터 ${durationText(dur)} ${sign < 0 ? '전' : '뒤'}`);
    }
  }
  // 시각 ± 기간: 오후 3시 + 2시간 30분 · 15:30 - 45분 · 9시부터 8시간 뒤
  if ((m = s.match(new RegExp(`^(.+?)\\s*(?:(\\+|-|−|더하기|빼기)|부터|에서)\\s*(.+?)\\s*(${AFTER}|${BEFORE})?$`)))) {
    const c = parseClock(m[1]);
    const dur = parseDuration(m[3]);
    if (c && dur && hasClock(dur) && !dur.y && !dur.mo && !dur.w) {
      const back = m[2] ? /^(-|−|빼기)$/.test(m[2]) : m[4] && new RegExp(`^${BEFORE}$`).test(m[4]);
      const total = c.h * 60 + c.min + (back ? -1 : 1) * (dur.d * 1440 + dur.h * 60 + dur.min);
      const dayShift = Math.floor(total / 1440);
      const mins = ((total % 1440) + 1440) % 1440;
      const d = at(Math.floor(mins / 60), mins % 60);
      d.setDate(d.getDate() + dayShift);
      const base = clockText(c.h, c.min);
      return { ...show(d, `${base}부터 ${durationText(dur)} ${back ? '전' : '뒤'}`), value: `${dayShift > 0 ? '다음 날 ' : dayShift < 0 ? '전날 ' : ''}${clockText(d.getHours(), d.getMinutes())}`, plain: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
    }
  }
  // 두 시각 사이: 9:15부터 18:30까지 · 9:15 ~ 18:30 · 14:30 - 9:15 · 오후 10시부터 오전 2시까지
  if ((m = s.match(new RegExp(`^(.+?)\\s*(?:부터|에서|~|〜|–)\\s*(.+?)\\s*(?:까지)?\\s*(?:몇\\s*시간|얼마|시간)?$`)) ?? s.match(/^(.+?)\s+(-|−)\s+(.+)$/))) {
    const minus = m.length === 4 && /^(-|−)$/.test(m[2]);
    const a = parseClock(minus ? m[3] : m[1]);
    const b = parseClock(minus ? m[1] : m[2]);
    if (a && b) {
      // 오전 · 오후 없이 쓴 1~6시는 오후로 본다 (3시부터 5시 반까지 → 오후 3시 ~ 5시 반) — 날짜 밑줄과 같은 규칙
      if (!a.ampm && a.h >= 1 && a.h <= 6) a.h += 12;
      if (!b.ampm && b.h >= 1 && b.h <= 6 && (a.h >= 12 || b.h + 12 > a.h)) b.h += 12;
      let bm = b.h * 60 + b.min;
      const am = a.h * 60 + a.min;
      // 오전 · 오후를 안 쓴 12시간제: 끝이 앞서면 12시간 뒤로 (3시 ~ 5시 반 그대로, 10시 ~ 2시 → 14시)
      if (bm < am && !b.ampm && b.h < 12 && b.h + 12 > a.h) bm += 720;
      let overnight = false;
      if (bm < am) {
        bm += 1440;
        overnight = true;
      }
      const total = bm - am;
      const h = Math.floor(total / 60);
      const mm = total % 60;
      const value = `${h ? `${h}시간` : ''}${h && mm ? ' ' : ''}${mm || !h ? `${mm}분` : ''}`;
      return { value, plain: `${h}:${pad2(mm)}`, detail: `${clockText(a.h, a.min)} ~ ${overnight ? '다음 날 ' : ''}${clockText(Math.floor(bm / 60) % 24, bm % 60)}, ${total}분` };
    }
  }
  return null;
}
