// 글 속 일정 자동 등록 (순수 함수) — 날짜 해석기(date-detect)가 앞으로의 날짜가 있는 줄을 찾고,
//   AI 는 그중 진짜 일정(약속 · 회의 · 마감 · 할 일)만 번호로 고르고 짧은 이름을 짓는다. 날짜 계산은 해석기가 (작은 모델은 날짜 계산을 자주 틀림).
//   본 줄은 머리말 aiEvents 에 남겨 다시 넣지 않는다 (지운 일정이 되살아나지 않게).
import { findAllDates, guessTitle } from './date-detect.js';
import { eventFromDate } from './reminders.js';
import { plainLines } from './memo-file.js';

export const MAX_SEEN = 300; // 기억해 둘 본 줄 (오래된 것부터 잊음)
const keyOf = (line) => line.trim().slice(0, 120);

/** 아직 보지 않은 줄 중 앞으로의 날짜가 있는 것 → [{ key, line, date }] (줄마다 첫 날짜 하나) */
export function eventCandidates(body, seen = [], now = new Date()) {
  const done = new Set(seen);
  const out = [];
  for (const line of plainLines(String(body ?? ''))) {
    const key = keyOf(line);
    if (done.has(key)) continue;
    done.add(key);
    const date = findAllDates(line, { now })[0];
    if (date) out.push({ key, line: key, date });
  }
  return out;
}

/** → { messages, schema } */
export function aiEventRequest(cands) {
  const schema = {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        maxItems: cands.length,
        items: {
          type: 'object',
          properties: { n: { type: 'integer', minimum: 1, maximum: cands.length }, title: { type: 'string', maxLength: 30 } },
          required: ['n', 'title'],
        },
      },
    },
    required: ['events'],
  };
  const messages = [
    { role: 'system', content: '너는 메모에서 일정을 고르는 도우미다. 번호 붙은 줄 중 약속, 회의, 마감, 해야 할 일처럼 그때 무엇을 하는 줄만 고른다. 날씨, 지난 이야기, 날짜만 나온 줄은 고르지 않는다. 고른 줄마다 날짜와 시각을 뺀 짧은 한국어 일정 이름(15자 안팎)을 title에 쓴다.' },
    { role: 'user', content: cands.map((c, i) => `${i + 1}. ${c.line}`).join('\n') },
  ];
  return { messages, schema };
}

/** 모델 답(JSON 글) → 넣을 일정 [reminder] — 번호 밖 · 겹치는 번호는 빼고, 이름이 비면 줄에서 짐작, 이미 있는 일정과 같은 때 · 이미 지난 때는 뺀다 */
export function aiEventResult(json, cands, existing = [], now = new Date()) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const same = (a, b) => a.kind === b.kind && (a.kind === 'at' ? a.at === b.at : JSON.stringify(a.repeat) === JSON.stringify(b.repeat));
  const out = [];
  const used = new Set();
  for (const e of Array.isArray(data.events) ? data.events : []) {
    const c = cands[Number(e?.n) - 1];
    if (!c || used.has(c)) continue;
    used.add(c);
    const title = String(e.title ?? '').replace(/\p{Script=Han}/gu, '').trim().slice(0, 30) || guessTitle(c.line, c.date.from, c.date.to);
    const r = eventFromDate({ ...c.date, title }, now);
    const past = r?.kind === 'at' && new Date(r.at).getTime() + (r.allDay ? 86_400_000 : 0) <= now.getTime();
    if (r && !past && ![...existing, ...out].some((x) => same(x, r))) out.push(r);
  }
  return out;
}

/** 본 줄 목록 갱신 (새로 본 줄을 뒤에, MAX_SEEN 까지) */
export const nextSeen = (seen, cands) => [...seen, ...cands.map((c) => c.key)].slice(-MAX_SEEN);
