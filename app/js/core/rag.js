// AI 검색 (순수 함수) — 내 메모에서 찾아 출처를 단 답. 모델은 desktop/ai (이 PC 안, 인터넷 없이).
//   찾기: 낱말(TF-IDF, 지금 앱과 같은 토큰) + 한글 두 글자 조각(바이그램 — "회의했어" 로도 "회의" 를 찾게, 0.70.0)
//         + 제목에 든 말 · 물은 때(지난주 · 어제 …)에 고친 메모를 앞으로 + 그래프(연결 · 관련도, index.json).
//   뜻으로 찾기는 따로 검색 모델 없이 글 모델(카나나2)이 질문을 비슷한 말 몇 개로 넓혀 낱말 찾기에 더한다 (expandMessages).
//   작은 모델은 지어내기도 쉽고 "못 찾았어요" 로 물러서기도 쉬워, 찾기가 일을 대부분 하고 모델은 고른 메모만 보고 짧게 답한다.
//   찾은 메모가 분명한데 모델이 물러서면 그 메모에서 가장 맞는 문장을 그대로 보여 준다 (finishAnswer).
import { tokenize, cosine } from './indexer.js';
import { plainLines, extractTitle } from './memo-file.js';

const CHUNK = 400; // 글자 — 한 조각이 문맥에 여럿 들어가게
const MAX_CHUNKS = 20; // 메모 하나에서
const CONTEXT = 2400; // 답할 때 모델에 주는 메모 글자 (4096 토큰 문맥에 질문 · 답과 함께 — 카나나는 한글 한 토큰에 1~2자)
const MAX_WORDS = 6; // 질문을 넓힐 낱말 수
const KEEP = 0.25; // 맨 위 메모 점수의 이만큼은 돼야 함께 보여 준다 (조금만 걸린 메모로 문맥이 흐려지지 않게)
const STRONG = 0.12; // 이만큼 맞으면 모델이 물러서도 문장을 그대로 보여 준다
export const NOT_FOUND = '메모에서 찾지 못했어요.';

// 물음 말 — 메모에 쓰였을 리 없어 찾기에서 뺀다 ("출시일 언제야" 의 "언제야")
const ASK_WORDS = new Set(['뭐야', '뭐였지', '뭐지', '뭐', '무엇', '무엇이', '무엇인지', '언제', '언제야', '언제지', '언제였지', '어디', '어디야', '어디였지', '누구', '누구야', '누가', '몇', '몇시', '몇일', '며칠', '얼마', '얼마야', '어떻게', '어떤', '왜', '알려줘', '알려', '알려주세요', '있어', '있나', '있었지', '했어', '했지', '했나', '했었지', '였지', '이었지', '인가', '일까', '거야', '건가', '건지', '그거', '그게', '내가', '우리', '메모', '메모에서', '찾아줘', '찾아', '말해줘', '기억나', '해줘', '좀', '혹시', '있는지', '했는지', '인지']);

/** 찾기 특징: 낱말 + 한글 낱말의 두 글자 조각 (조사 · 어미가 달라도 맞게) */
function features(text, { ask = false } = {}) {
  const words = tokenize(text).filter((w) => !(ask && ASK_WORDS.has(w)));
  const out = [...words];
  for (const w of words) {
    if (!/^\p{Script=Hangul}{2,}$/u.test(w)) continue;
    for (let i = 0; i + 2 <= w.length; i++) out.push(`·${w.slice(i, i + 2)}`); // 두 글자 낱말은 그 자체가 조각 ("출시" ↔ "출시일")
  }
  return out;
}

/** 메모 → 조각 글들 (줄을 모아 CHUNK 자 안팎, 조각마다 앞에 제목 — 어느 조각이 걸려도 무슨 메모인지 알게) */
export function chunkMemo(body) {
  const title = extractTitle(body);
  const lines = plainLines(body).slice(1);
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length > CHUNK) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur || !out.length) out.push(cur);
  return out.slice(0, MAX_CHUNKS).map((text) => `${title}\n${text}`.trim());
}

/**
 * 물은 때: "오늘 · 어제 · 이번 주 · 지난주 · 이번 달 · 지난달 · 올해" → { from, to } (그때 고친 메모를 앞으로)
 * @returns {{ from: Date, to: Date } | null}
 */
export function askedPeriod(question, now = new Date()) {
  const q = String(question ?? '');
  const day = (d, n = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monday = (d) => day(d, -((d.getDay() + 6) % 7));
  if (/오늘/.test(q)) return { from: day(now), to: day(now, 1) };
  if (/어제/.test(q)) return { from: day(now, -1), to: day(now) };
  if (/그저께|그제/.test(q)) return { from: day(now, -2), to: day(now, -1) };
  if (/지난\s*주|저번\s*주/.test(q)) return { from: day(monday(now), -7), to: monday(now) };
  if (/이번\s*주|금주/.test(q)) return { from: monday(now), to: day(monday(now), 7) };
  if (/지난\s*달|저번\s*달/.test(q)) return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1) };
  if (/이번\s*달/.test(q)) return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  if (/올해|금년/.test(q)) return { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear() + 1, 0, 1) };
  return null;
}

const termCounts = (list) => {
  const tf = new Map();
  for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
};
/** tf-idf (indexer.js tfidfVectors 와 같은 셈), 길이 1로 */
function weigh(tf, df, n) {
  const v = new Map();
  let norm = 0;
  for (const [t, count] of tf) {
    const w = (1 + Math.log(count)) * Math.log(1 + n / (df.get(t) ?? 1));
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

/**
 * 찾기 색인: 조각마다 tf-idf 벡터. 메모가 바뀔 때만 다시 만든다 (메모 3,000개면 만드는 데 1초 남짓 — 묻을 때마다 하면 그동안
 *   메인 프로세스가 멈춰 모든 창이 굳었다). 조각의 특징(c.feats)은 조각 객체에 남겨 두어, 그대로인 메모는 다시 쪼개지 않는다
 * @param {{ id: string, title: string, text: string, updated?: string, feats?: string[] }[]} chunks
 */
export function buildIndex(chunks) {
  const df = new Map();
  const tfs = chunks.map((c) => {
    c.feats ??= features(c.text);
    const tf = termCounts(c.feats);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const n = chunks.length;
  return { chunks, df, n, vecs: tfs.map((tf) => weigh(tf, df, n)) };
}

/**
 * 관련 메모 찾기
 * @param {string} query
 * @param {{ id: string, title: string, text: string, updated?: string }[] | ReturnType<typeof buildIndex>} source 모든 메모의 조각 (또는 만들어 둔 색인)
 * @param {{ words?: string[], related?: (id: string) => { id: string, score: number }[], limit?: number, now?: Date }} o words: 질문을 넓힌 낱말 (expandMessages)
 * @returns {{ id: string, title: string, score: number, via: 'match' | 'graph', texts: string[] }[]}
 */
export function retrieve(query, source, { words = [], related = () => [], limit = 4, now = new Date() } = {}) {
  const index = Array.isArray(source) ? buildIndex(source) : source;
  const { chunks, vecs } = index;
  if (!chunks.length) return [];
  const qf = [...features(query, { ask: true }), ...words.flatMap((w) => features(w))];
  if (!qf.length) return [];
  const q = weigh(termCounts(qf), index.df, index.n + 1);
  const asked = new Set(tokenize(query).filter((w) => !ASK_WORDS.has(w)));
  const period = askedPeriod(query, now);
  const inPeriod = (c) => period && c.updated && new Date(c.updated) >= period.from && new Date(c.updated) < period.to;
  const ranked = vecs.map((v, i) => {
    const c = chunks[i];
    let s = cosine(q, v);
    if (s <= 0) return [i, 0];
    if (tokenize(c.title ?? '').some((w) => asked.has(w))) s *= 1.3; // 제목에 물은 말
    if (inPeriod(c)) s *= 1.5;
    return [i, s];
  }).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  const memos = new Map();
  for (const [i, score] of ranked) {
    const c = chunks[i];
    const m = memos.get(c.id) ?? memos.set(c.id, { id: c.id, title: c.title, score, via: 'match', texts: [] }).get(c.id);
    if (m.texts.length < 3) m.texts.push(c.text);
  }
  const best = ranked[0]?.[1] ?? 0;
  const top = [...memos.values()].filter((m) => m.score >= best * KEEP).slice(0, limit);
  // 그래프: 찾은 메모와 연결 · 비슷한 메모 (찾기에서 놓친 것) — 앞 메모 점수의 절반 × 관련도
  const byId = new Map(chunks.map((c) => [c.id, c]));
  for (const m of top.slice(0, 2)) {
    for (const r of related(m.id).slice(0, 2)) {
      if (memos.has(r.id) || !byId.has(r.id)) continue;
      const c = byId.get(r.id);
      const g = { id: r.id, title: c.title, score: m.score * 0.5 * r.score, via: 'graph', texts: [c.text] };
      memos.set(r.id, g);
      top.push(g);
    }
  }
  return top.sort((a, b) => b.score - a.score).slice(0, limit + 1);
}

/** 질문 넓히기: 메모에 쓰였을 만한 비슷한 말 · 바꿔 쓴 말 (뜻으로 찾기 대신) → { messages, schema } */
export function expandMessages(question) {
  return {
    messages: [
      { role: 'system', content: `너는 메모 검색을 돕는다. 질문의 답이 적힌 메모에 쓰였을 만한 한국어 낱말을 ${MAX_WORDS}개까지 고른다. 질문의 낱말과 비슷한 말, 바꿔 쓴 말, 줄임말을 넣는다. 낱말만 쓴다.` },
      { role: 'user', content: question },
    ],
    schema: { type: 'object', properties: { words: { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: MAX_WORDS } }, required: ['words'] },
  };
}

/** 넓힌 낱말 답(JSON 글) → 낱말들 (엉뚱한 답이면 []) */
export function expandResult(json) {
  try {
    const words = JSON.parse(json).words;
    return Array.isArray(words) ? words.map((w) => String(w).trim()).filter(Boolean).slice(0, MAX_WORDS) : [];
  } catch {
    return [];
  }
}

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 답하기: 고른 메모만 근거로, 번호로 출처를 달게 (오늘 날짜도 — "다음 주 회의" 같은 물음에) */
export function ragMessages(question, picked, now = new Date()) {
  let budget = CONTEXT;
  const parts = [];
  picked.forEach((m, i) => {
    const text = m.texts.join('\n').slice(0, Math.max(0, budget));
    budget -= text.length;
    if (text) parts.push(`[${i + 1}] ${m.title}\n${text}`);
  });
  const today = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${DAYS[now.getDay()]}요일`;
  return [
    { role: 'system', content: `너는 사용자의 메모를 읽고 질문에 답하는 비서다. 오늘은 ${today}이다. 아래 [번호] 메모에 적힌 것만 근거로 한국어 해요체로 1~3문장 답한다. 문장 끝에 근거 메모 번호를 [1]처럼 붙인다. 질문과 관련된 내용이 조금이라도 있으면 있는 만큼 답하고, 모르는 부분만 모른다고 한다. 관련 내용이 전혀 없을 때만 "${NOT_FOUND}"라고 답한다. 메모에 없는 것은 지어내지 않는다.` },
    { role: 'user', content: `메모:\n${parts.join('\n\n')}\n\n질문: ${question}` },
  ];
}

/** 찾은 메모에서 질문과 가장 맞는 문장 (그대로 보여 줄 때) → { text, n } | null  n: 몇 번 메모 */
export function bestSentence(question, picked) {
  const qf = new Set(features(question, { ask: true }));
  if (!qf.size) return null;
  let best = null;
  picked.forEach((m, i) => {
    if (m.via === 'graph') return;
    for (const text of m.texts) {
      for (const s of text.split('\n').slice(1).flatMap((line) => line.split(/(?<=[.!?。])\s+/))) {
        const f = new Set(features(s));
        const hit = [...qf].filter((x) => f.has(x)).length;
        if (!hit) continue;
        const score = hit / qf.size + (i === 0 ? 0.05 : 0);
        if (!best || score > best.score) best = { text: s.trim().slice(0, 200), n: i + 1, score };
      }
    }
  });
  return best && { text: best.text, n: best.n };
}

/**
 * 모델 답 다듬기: 없는 번호는 지우고, 분명히 찾았는데 물러섰으면(못 찾았어요 · 번호 없음) 메모의 문장을 그대로
 * @returns {{ text: string, quoted: boolean }}
 */
export function finishAnswer(answer, question, picked) {
  let text = String(answer ?? '').trim().replace(/\[(\d+)\]/g, (all, n) => (Number(n) >= 1 && Number(n) <= picked.length ? all : ''));
  const gaveUp = !text || text.includes('찾지 못했');
  const strong = picked[0] && picked[0].via !== 'graph' && picked[0].score >= STRONG;
  const s = strong && (gaveUp || !/\[\d+\]/.test(text)) ? bestSentence(question, picked) : null;
  // 물러섰으면 문장을 그대로, 답은 했는데 번호가 없으면 근거 문장을 아래에 (지어낸 답인지 바로 보이게)
  if (s && gaveUp) return { text: `메모에 이렇게 적혀 있어요.\n“${s.text}” [${s.n}]`, quoted: true };
  if (s) return { text: `${text}\n근거: “${s.text}” [${s.n}]`, quoted: true };
  return { text: text || NOT_FOUND, quoted: false };
}
