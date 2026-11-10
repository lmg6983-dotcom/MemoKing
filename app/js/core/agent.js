// 매직 에이전트 (순수 함수) — 목록 검색창 ✦ · 매직키 AI 줄이 함께 쓴다. 쓴 말이 질문인지 할 일인지 가려서:
//   answer  메모에서 찾아 출처를 단 답 (rag.js)
//   summary 찾은 메모들을 묶어 요약 (새 메모로 저장할 수 있게)
//   event   일정 · 알림 등록 — 날짜는 글 속 날짜 해석기(date-detect)가, 모델은 쓰지 않는다
//   memo    새 메모 · 할 일(체크리스트)
//   append  찾은 메모 끝에 덧붙이기
//   무언가를 바꾸는 일(event · memo · append)은 바로 하지 않고 확인 카드를 돌려준다 — 고치거나 취소할 수 있게.
//   작은 모델(3B)은 고르기를 자주 틀려, 말 모양으로 먼저 가르고(규칙) 애매한 명령만 모델에 묻는다 (planMessages).
import { findDates, guessTitle } from './date-detect.js';
import { searchMemos } from './memo-search.js';
import { extractTitle } from './memo-file.js';
import { isLockedBody } from './memo-lock.js';

export const ACTIONS = ['answer', 'summary', 'event', 'memo', 'append'];

// 부탁 끝말 — 할 일 이름 · 내용에서 뺀다
const ASK_TAIL = /\s*(?:좀\s*)?(?:해\s*줘|해\s*주세요|해\s*줄래\??|해\s*줄\s*수\s*있어\??|부탁해(?:요)?|해\s*봐|하자|해요|할래|해|줘|주세요)\s*[.!?~]*\s*$/;
const EVENT_VERB = /(알려\s*(?:줘|주세요|줄래)|알림|리마인드|일정|예약|약속\s*잡|잡아\s*(?:줘|주세요)|등록|챙겨\s*(?:줘|주세요)|깨워|기억해\s*(?:줘|주세요)|넣어\s*(?:줘|주세요)|추가해\s*(?:줘|주세요))/;
// 일정을 넣으라고 시키는 말 — 이게 없으면 질문("치과 예약 몇 시였지?")은 일정 넣기가 아니다
const EVENT_DO = /(알려\s*(?:줘|주세요|줄래)|등록|잡아\s*(?:줘|주세요)|넣어\s*(?:줘|주세요)|추가해\s*(?:줘|주세요)|챙겨\s*(?:줘|주세요)|깨워|기억해\s*(?:줘|주세요)|리마인드|알림\s*(?:줘|주세요|설정|맞춰))/;
const SUMMARY_VERB = /(요약|정리|간추려|한눈에)\s*(?:해|좀|해서|해줘|해 줘|해주세요|해 주세요|부탁|$)|요약$|정리$/;
const MEMO_VERB = /(?:(메모|노트|할\s*일|할일|체크\s*리스트|체크리스트|목록|리스트|투두)(?:를|을|로|으로)?\s*(?:하나\s*)?(?:만들어|써|작성|남겨|적어|새로)|^(?:메모|기록)\s*(?:해|해줘|해 줘|해주세요|남겨))/;
const APPEND = /^(.+?)\s*(?:메모|노트|목록|리스트)?\s*(?:에|에다|에다가)\s+(.+?)\s*(?:을|를)?\s*(?:추가|덧붙|붙여|적어|넣어|기록|더해)/;
const MEMO_WORDS = /\s*(?:(?:메모|노트|할\s*일|할일|체크\s*리스트|체크리스트|목록|리스트|투두)(?:를|을|로|으로)?\s*)?(?:하나\s*)?(?:만들어|써|작성해|작성|남겨|적어)\s*(?:줘|주세요|줄래)?\s*$/;
const QUESTION = /[?？]\s*$|(?:알려\s*(?:줘|주세요|줄래)|찾아\s*(?:줘|주세요)|말해\s*(?:줘|주세요)|뭐|무엇|언제|어디|누구|누가|몇|얼마|어떻게|어떤|왜|있나|있어\s*\??$|했나|했지|였지|이었지|인가|일까|나요|까요|니\s*\??$|냐\s*\??$|야\s*\??$)/;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripAsk = (s) => clean(String(s ?? '').replace(ASK_TAIL, ''));

/** 쉼표 · "랑" · "하고" · 줄로 나눈 항목들 ("우유, 계란이랑 빵" → [우유, 계란, 빵]) */
export function splitItems(text) {
  return String(text ?? '')
    .split(/\s*(?:\n|,|，|、|·|;|(?<=\S)(?:이랑|랑|하고|와|과)\s+)\s*/)
    .map((s) => s.replace(/^[-*•]\s*/, '').replace(/\s*(?:을|를|도)$/, '').trim())
    .filter((s) => s && s.length <= 80);
}

/**
 * 말 모양으로 가르기 → { action, ... } — 확실하지 않으면 { action: 'answer', unsure } (unsure: 명령처럼 보이는데 못 가름 → 모델에 묻는다)
 * @param {string} text
 * @param {{ now?: Date }} [o]
 */
export function detectIntent(text, { now = new Date() } = {}) {
  const t = clean(text);
  if (!t) return { action: 'answer' };
  const question = QUESTION.test(t) && (!ASK_TAIL.test(t) || /알려|찾아|말해/.test(t));
  // 덧붙이기: "회의록에 다음 주 발표 추가해줘"
  //   "금요일 2시에 치과 예약 추가해줘" 의 "금요일 2시" 는 메모가 아니라 때 — 일정으로
  const ap = APPEND.exec(t);
  if (ap && !question && !isWhen(ap[1], now)) return { action: 'append', target: clean(ap[1]), content: stripAsk(ap[2]) };
  // 일정: 앞으로의 날짜 + 알려줘 · 등록 · 예약 … (질문이면 시키는 말이 있을 때만)
  const when = findDates(t, now).find((d) => d.at > now || d.repeat);
  if (when && EVENT_VERB.test(t) && (!question || EVENT_DO.test(t))) return { action: 'event', ...eventFields(t, when) };
  if (SUMMARY_VERB.test(t) && !question) return { action: 'summary', topic: summaryTopic(t) };
  const mm = MEMO_VERB.exec(t);
  if (mm) return { action: 'memo', ...memoFields(t, mm) };
  // 날짜만 있고 명령 꼴이면 ("금요일 3시 치과" 처럼 질문이 아닌 짧은 줄) 일정으로 묻는다
  if (when && !question) return { action: 'event', ...eventFields(t, when), unsure: true };
  return { action: 'answer', unsure: !question && ASK_TAIL.test(t) };
}

/** 글이 날짜 · 시각 말뿐인가 ("금요일 2시", "내일 오후 3시에") */
function isWhen(text, now) {
  const s = String(text ?? '');
  const ds = findDates(s, now);
  if (!ds.length) return false;
  let rest = s;
  for (const d of [...ds].reverse()) rest = rest.slice(0, d.from) + rest.slice(d.to);
  return !rest.replace(/(?:에|에는|쯤|경|까지|부터)/g, '').trim();
}

// 일정 이름에서 뺄 부탁 말 ("치과 예약 알려줘" → "치과 예약")
const EVENT_ASK = /\s*(?:(?:일정|알림|알람|리마인드)(?:으로|로|을|를)?\s*)?(?:알려|알림|등록|리마인드|잡아|챙겨|깨워|기억해|넣어|추가해|추가|설정|맞춰)?\s*(?:해\s*)?(?:줘|주세요|줄래|해|하기|할래|부탁해)?\s*[.!?~]*\s*$/;
function eventFields(t, when) {
  let title = clean(guessTitle(t, when.from, when.to));
  for (let i = 0; i < 3; i++) title = clean(title.replace(ASK_TAIL, '').replace(EVENT_ASK, '').replace(/\s*(?:에|을|를|좀|으로|로|라고|이라고|일정|알림)$/, ''));
  return { title: title.slice(0, 60) || (/깨워|알람/.test(t) ? '알람' : '일정'), when: { at: when.at.toISOString(), hasTime: when.hasTime, repeat: when.repeat ?? null, ...(when.end ? { end: when.end.toISOString() } : {}), text: when.text } };
}

function memoFields(t, m) {
  const list = /할\s*일|할일|체크\s*리스트|체크리스트|목록|리스트|투두/.test(m[1] ?? '');
  // "장보기 목록 만들어줘: 우유, 계란" · "우유 계란 사야 하는 거 메모해줘"
  const [head, tail] = t.includes(':') ? [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)] : [t.slice(0, m.index), t.slice(m.index + m[0].length)];
  const title = stripAsk(head.replace(MEMO_WORDS, '').replace(/(?:을|를|로|으로)$/, '')).replace(/\s*(?:메모|노트|할\s*일|목록|리스트|체크\s*리스트|투두)$/, '').slice(0, 60);
  const rest = stripAsk(tail.replace(/^\s*(?:줘|주세요|해\s*줘|해줘|해주세요)\s*/, ''));
  let items = list ? splitItems(rest) : [];
  if (list && !items.length && /[,，、]/.test(title)) items = splitItems(title); // "우유, 계란 할 일로 만들어줘"
  return { title: items.length && /[,，、]/.test(title) ? '' : title, list, items, text: list ? '' : rest };
}

function summaryTopic(t) {
  return clean(t.replace(SUMMARY_VERB, ' ').replace(ASK_TAIL, '').replace(/(?:을|를|좀|에\s*대해|관련|내용|메모들?|것들?)(?=\s|$)/g, ' ')) || t;
}

/** 애매한 명령만: 모델이 할 일을 고른다 (JSON) → { messages, schema } */
export function planMessages(text) {
  return {
    messages: [
      { role: 'system', content: '너는 메모 앱의 비서다. 사용자의 말이 무엇을 바라는지 하나를 고른다. answer: 메모에서 무엇을 찾아 답하기, summary: 메모들을 요약 · 정리, event: 일정 · 알림 등록, memo: 새 메모나 할 일 목록 만들기, append: 이미 있는 메모에 내용 덧붙이기. target 은 덧붙일 메모 이름, content 는 덧붙이거나 새로 쓸 내용, title 은 일정이나 새 메모의 짧은 이름이다. 모르면 answer.' },
      { role: 'user', content: text },
    ],
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        title: { type: 'string', maxLength: 60 },
        target: { type: 'string', maxLength: 60 },
        content: { type: 'string', maxLength: 600 },
      },
      required: ['action'],
    },
  };
}

/** 모델이 고른 것(JSON 글) → detectIntent 와 같은 꼴. 엉뚱하거나 필요한 것이 없으면 answer */
export function planResult(json, text, { now = new Date() } = {}) {
  let p;
  try {
    p = JSON.parse(json);
  } catch {
    return { action: 'answer' };
  }
  const t = clean(text);
  if (p.action === 'event') {
    const when = findDates(t, now).find((d) => d.at > now || d.repeat);
    if (!when) return { action: 'answer' }; // 날짜는 해석기가 찾은 것만 — 모델이 지은 날짜는 믿지 않는다
    const f = eventFields(t, when);
    return { action: 'event', ...f, title: clean(p.title).slice(0, 60) || f.title };
  }
  if (p.action === 'append' && clean(p.target) && clean(p.content)) return { action: 'append', target: clean(p.target), content: clean(p.content) };
  if (p.action === 'memo') {
    const items = splitItems(p.content);
    const list = items.length > 1;
    return { action: 'memo', title: clean(p.title).slice(0, 60), list, items: list ? items : [], text: list ? '' : clean(p.content) };
  }
  if (p.action === 'summary') return { action: 'summary', topic: summaryTopic(t) };
  return { action: 'answer' };
}

/** 덧붙일 메모 후보 (제목이 맞는 것부터, 잠긴 메모 빼고) → [{ id, title }] 최대 5 */
export function appendTargets(target, memos) {
  const open = memos.filter((m) => !isLockedBody(m.body));
  const key = clean(target).replace(/\s*(?:메모|노트)$/, '').toLocaleLowerCase('ko');
  const titled = open.map((m) => ({ id: m.id, title: extractTitle(m.body) || '제목 없음' }));
  const exact = titled.filter((m) => m.title.toLocaleLowerCase('ko') === key);
  const starts = titled.filter((m) => !exact.includes(m) && m.title.toLocaleLowerCase('ko').includes(key));
  const found = searchMemos(open.map((m) => ({ ...m, title: extractTitle(m.body) })), key, 5).map((r) => titled.find((m) => m.id === r.id)).filter(Boolean);
  const out = [];
  for (const m of [...exact, ...starts, ...found]) if (!out.some((o) => o.id === m.id)) out.push(m);
  return out.slice(0, 5);
}

/** 새 메모 본문: 제목 + (할 일이면 체크리스트, 아니면 글) */
export function memoBody({ title, list, items, text }) {
  const head = clean(title) ? `# ${clean(title)}\n\n` : '';
  if (list && items?.length) return `${head}${items.map((i) => `- [ ] ${clean(i)}`).join('\n')}\n`;
  return `${head}${String(text ?? '').trim()}\n`;
}

/** 덧붙일 글: 여러 항목이면 줄마다 "- " */
export function appendText(content) {
  const items = splitItems(content);
  return items.length > 1 ? items.map((i) => `- ${i}`).join('\n') : clean(content);
}

/** 요약 저장 본문: 제목 · 요약 · 출처 메모 ([[제목]] 연결) */
export function summaryBody(topic, text, sources) {
  const links = sources.map((s) => `- [[${s.title || '제목 없음'}]]`).join('\n');
  return `# ${clean(topic).slice(0, 50) || '요약'} 요약\n\n${String(text).replace(/\s*\[\d+\]/g, '').trim()}\n\n출처\n${links}\n`;
}

/** 요약하기: 찾은 메모들만 근거로, 번호로 출처를 달게 */
export function summaryMessages(topic, picked, budget = 2400) {
  const parts = [];
  picked.forEach((m, i) => {
    const text = m.texts.join('\n').slice(0, Math.max(0, budget));
    budget -= text.length;
    if (text) parts.push(`[${i + 1}] ${m.title}\n${text}`);
  });
  return [
    { role: 'system', content: '너는 사용자의 메모를 요약하는 비서다. 아래 [번호] 메모에 적힌 것만으로 한국어 해요체 요약을 쓴다. 중요한 것부터 "- " 로 시작하는 줄 3~6개로 쓰고, 줄 끝에 근거 메모 번호를 [1]처럼 붙인다. 메모에 없는 것은 쓰지 않는다.' },
    { role: 'user', content: `메모:\n${parts.join('\n\n')}\n\n요약할 것: ${topic}` },
  ];
}

// ---------- 일정 묻기 ("내일 뭐 있어?" · "이번 주 회의 언제야") — 메모 글이 아니라 일정 탭에서 바로 ----------
const SCHEDULE_ASK = /(일정|약속|스케줄|계획|뭐\s*있|무슨\s*일|할\s*일|회의|미팅|마감|예약)/;
const DAY_MS = 86_400_000;

/**
 * 일정을 묻는 말이면 그 기간과 찾을 말 → { from, to, label, words } | null
 * @param {string} text
 */
export function scheduleQuery(text, now = new Date()) {
  const t = clean(text);
  if (!SCHEDULE_ASK.test(t) || !QUESTION.test(t)) return null;
  const day = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const monday = (n) => day(-((now.getDay() + 6) % 7) + n * 7);
  let range = null;
  if (/오늘/.test(t)) range = { from: day(0), to: day(1), label: '오늘' };
  else if (/모레/.test(t)) range = { from: day(2), to: day(3), label: '모레' };
  else if (/내일/.test(t)) range = { from: day(1), to: day(2), label: '내일' };
  else if (/다음\s*주/.test(t)) range = { from: monday(1), to: monday(2), label: '다음 주' };
  else if (/이번\s*주|금주/.test(t)) range = { from: day(0), to: monday(1), label: '이번 주' };
  else if (/다음\s*달/.test(t)) range = { from: new Date(now.getFullYear(), now.getMonth() + 1, 1), to: new Date(now.getFullYear(), now.getMonth() + 2, 1), label: '다음 달' };
  else if (/이번\s*달/.test(t)) range = { from: day(0), to: new Date(now.getFullYear(), now.getMonth() + 1, 1), label: '이번 달' };
  else {
    const d = findDates(t, new Date(now.getTime() - DAY_MS)).find((x) => !x.repeat);
    if (d) {
      const at = new Date(d.at);
      range = { from: new Date(at.getFullYear(), at.getMonth(), at.getDate()), to: new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1), label: d.text };
    } else if (/다가오는|앞으로|곧|다음\s*일정/.test(t)) range = { from: now, to: day(14), label: '앞으로 2주' };
  }
  if (!range) return null;
  // 찾을 말: 일정 이름에 들어갈 만한 말만 ("내일 회의 몇 시야" → 회의)
  const words = t.replace(/[?？.!]/g, ' ').split(/\s+/)
    .map((w) => w.replace(/(?:은|는|이|가|을|를|에|에는|도|이야|야|이지|지)$/, ''))
    .filter((w) => w.length >= 2 && !/^(오늘|내일|모레|이번|다음|주|달|금주|일정|약속|스케줄|계획|뭐|무슨|있어|있나|있지|언제|몇|시|몇시|할|일|알려줘|알려|좀|나|내|다가오는|앞으로|곧)$/.test(w) && !/일정|약속|스케줄/.test(w));
  return { ...range, words };
}

/**
 * 그 기간의 일정 회차 → [{ at, title, memoId, allDay }] (시각 순, 잠긴 메모 · 꺼진 일정 빼고)
 * @param {{ memoId: string, title: string, locked?: boolean, reminder: any }[]} all vault.allReminders()
 * @param {(r, from, to) => Date[]} occurrences reminders.js occurrencesBetween
 */
export function eventsIn(all, q, occurrences) {
  const out = [];
  for (const e of all) {
    const r = e.reminder;
    if (e.locked || !r?.enabled) continue;
    const name = r.title || e.title || '일정';
    for (const at of occurrences(r, q.from, q.to)) out.push({ at, title: name, memoId: e.memoId, allDay: Boolean(r.allDay) });
  }
  out.sort((a, b) => a.at - b.at);
  // 찾을 말("내일 회의 몇 시야" 의 회의)이 있으면 그 말이 든 일정만 — 없으면 [] (부른 쪽이 메모에서 찾는다)
  return q.words?.length ? out.filter((e) => q.words.some((w) => e.title.includes(w))) : out;
}

/** 일정 답 글: "내일 일정이에요.\n- 오후 3:00 거래처 미팅 [1]" (번호는 출처 메모) */
export function scheduleText(q, events, now = new Date()) {
  if (!events.length) return `${q.label} 일정은 없어요.`;
  const ids = [...new Set(events.map((e) => e.memoId))];
  const sameDay = q.to - q.from <= DAY_MS;
  const lines = events.slice(0, 12).map((e) => {
    const d = new Date(e.at);
    const day = sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]}) `;
    const time = e.allDay ? '하루 종일' : `${d.getHours() < 12 ? '오전' : '오후'} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `- ${day}${time} ${e.title} [${ids.indexOf(e.memoId) + 1}]`;
  });
  const more = events.length > 12 ? `\n외 ${events.length - 12}개` : '';
  return `${q.label} 일정이에요.\n${lines.join('\n')}${more}`;
}

/** 새 메모 · 할 일인데 내용이 없을 때 ("출시 준비 체크리스트 만들어줘"): 모델이 초안 항목을 짓는다 → { messages, schema } */
export function memoDraftMessages(text, intent) {
  const list = intent.list;
  return {
    messages: [
      { role: 'system', content: list
        ? '너는 메모 앱의 비서다. 사용자의 부탁에 맞는 할 일 목록을 짓는다. title 은 목록의 짧은 이름, items 는 할 일 3~8개다. 각 항목은 짧은 명사구나 동사구로 쓴다.'
        : '너는 메모 앱의 비서다. 사용자의 부탁에 맞는 메모를 짓는다. title 은 짧은 이름, body 는 메모 내용(몇 줄)이다. 모르는 사실은 [ ] 칸으로 비워 둔다.' },
      { role: 'user', content: text },
    ],
    schema: list
      ? { type: 'object', properties: { title: { type: 'string', maxLength: 40 }, items: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 10 } }, required: ['title', 'items'] }
      : { type: 'object', properties: { title: { type: 'string', maxLength: 40 }, body: { type: 'string', maxLength: 800 } }, required: ['title', 'body'] },
  };
}

/** 초안 답(JSON 글) → intent 에 채운 것 (엉뚱하면 그대로) */
export function memoDraftResult(json, intent) {
  try {
    const d = JSON.parse(json);
    const title = clean(intent.title) || clean(d.title).slice(0, 60);
    if (intent.list) {
      const items = (Array.isArray(d.items) ? d.items : []).map(clean).filter(Boolean).slice(0, 10);
      return items.length ? { ...intent, title, items, drafted: true } : intent;
    }
    const text = String(d.body ?? '').trim().slice(0, 2000);
    return text ? { ...intent, title, text, drafted: true } : intent;
  } catch {
    return intent;
  }
}
