// AI 받은함 (_memoking/AI 받은함 Google 시트) — AI(Gemini 등)가 메모를 만들고 고치는 단 하나의 창구.
//   desktop-rs/core/src/sheet_inbox.rs 와 같은 규칙 (tests/parity.rs sheet_inbox). 시트는 CSV 로 내려받고 CSV 로 덮어쓴다 (drive.file 권한만)
//   7열: req_id · action(create · append · replace · trash) · memo_id · folder · body · find · status
//   AI 가 status 를 pending 으로 적으면, 켜져 있는 기기 한 대(devices.js inboxLeader)가 처리하고 done (<memo_id>) · error: <까닭> 으로 바꾼다
import { cleanFolderName } from './folders.js';

export const SHEET_NAME = 'AI 받은함';
export const COLUMNS = ['req_id', 'action', 'memo_id', 'folder', 'body', 'find', 'status'];
export const BATCH = 20; // 한 차례에 처리하는 요청 수
export const KEEP_DONE = 20; // 처리를 마친 줄은 최근 이만큼만

/** RFC 4180 CSV → 줄마다 칸들. 따옴표 안의 쉼표 · 줄바꿈 · "" 를 읽고, 맨 앞 BOM · 끝의 빈 줄은 뗀다 */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    any = true;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      // \r\n 의 \r
    } else if (c === '\n' || c === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      any = false;
    } else cell += c;
  }
  if (any) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 칸들 → CSV (쉼표 · 따옴표 · 줄바꿈 · 앞뒤 빈칸이 든 칸만 따옴표로, 줄 끝은 \r\n) */
export function toCsv(rows) {
  const cell = (s) => (/[,"\n\r]/.test(s) || s.startsWith(' ') || s.endsWith(' ') ? `"${s.replaceAll('"', '""')}"` : s);
  return rows.map((r) => `${r.map(cell).join(',')}\r\n`).join('');
}

/** 시트 CSV → 줄들 { req_id … status }. 첫 줄에 req_id 가 있으면 머리 줄로 보고 열 이름으로(열 차례가 바뀌어도), 아니면 7열 차례대로 (모르는 열은 버린다) */
export function rowsFromCsv(text) {
  const cells = parseCsv(text);
  const header = (cells[0] ?? []).map((c) => c.trim().toLowerCase());
  const named = header.includes('req_id');
  const at = COLUMNS.map((name, i) => (named ? header.indexOf(name) : i));
  return cells
    .slice(named ? 1 : 0)
    .filter((c) => c.some((v) => v.trim()))
    .map((c) => Object.fromEntries(COLUMNS.map((name, i) => [name, at[i] >= 0 ? c[at[i]] ?? '' : ''])));
}

/** 줄들 → 시트에 올릴 CSV (머리 줄 포함) */
export const rowsToCsv = (rows) => toCsv([COLUMNS, ...rows.map((r) => COLUMNS.map((name) => r[name] ?? ''))]);

const isPending = (r) => r.status.trim().toLowerCase() === 'pending';

/**
 * 처리할 줄 (최대 BATCH 개): [{ index, job } | { index, error }]
 *   status 가 pending 인 줄만. 이미 처리한(또는 이번에 앞에서 본) req_id 는 거절해 같은 요청을 두 번 하지 않는다
 *   job: { action: 'create', folder, body } | { action: 'append', memoId, body } | { action: 'replace', memoId, find, body } | { action: 'trash', memoId }
 */
export function plan(rows) {
  const seen = new Set(rows.filter((r) => !isPending(r)).map((r) => r.req_id.trim()));
  const out = [];
  for (const [index, r] of rows.entries()) {
    if (out.length >= BATCH) break;
    if (!isPending(r)) continue;
    const id = r.req_id.trim();
    if (!id) out.push({ index, error: 'req_id 가 비었어요' });
    else if (seen.has(id)) out.push({ index, error: '이미 처리한 req_id 예요' });
    else {
      seen.add(id);
      out.push({ index, ...jobOf(r) });
    }
  }
  return out;
}

function jobOf(r) {
  const memoId = r.memo_id.trim();
  const needMemo = () => (!memoId ? 'memo_id 가 비었어요' : /[/\\]|\.\./.test(memoId) ? '쓸 수 없는 memo_id 예요' : null);
  const body = r.body.trim();
  const action = r.action.trim().toLowerCase();
  if (action === 'create') {
    if (!body) return { error: 'body 가 비었어요' };
    const raw = r.folder.trim();
    const folder = cleanFolderName(raw);
    if (/[/\\]|\.\./.test(raw) || raw.toLowerCase().includes('_memoking') || (raw && !folder)) return { error: '쓸 수 없는 folder 예요 (/ \\ .. _memoking 은 안 돼요)' };
    return { job: { action, folder, body } };
  }
  if (action === 'append') {
    const bad = needMemo();
    if (bad) return { error: bad };
    if (!body) return { error: 'body 가 비었어요' };
    return { job: { action, memoId, body } };
  }
  if (action === 'replace') {
    const bad = needMemo();
    if (bad) return { error: bad };
    if (!r.find) return { error: 'find 가 비었어요' };
    return { job: { action, memoId, find: r.find, body: r.body } };
  }
  if (action === 'trash') {
    const bad = needMemo();
    return bad ? { error: bad } : { job: { action, memoId } };
  }
  if (!action) return { error: 'action 이 비었어요' };
  return { error: `모르는 action 이에요 (${action}). create · append · replace · trash 중 하나` };
}

/**
 * 처리 결과를 status 에 적고, 처리를 마친 줄은 최근 KEEP_DONE 개만 남긴다 (아직 pending 인 줄은 모두 남김)
 * @param {object[]} rows  @param {{ index: number, id?: string, error?: string }[]} results
 */
export function finish(rows, results) {
  const next = rows.map((r) => ({ ...r }));
  for (const { index, id, error } of results) {
    if (next[index]) next[index].status = error ? `error: ${error}` : `done (${id})`;
  }
  let drop = Math.max(0, next.filter((r) => !isPending(r)).length - KEEP_DONE);
  return next.filter((r) => {
    if (drop > 0 && !isPending(r)) {
      drop--;
      return false;
    }
    return true;
  });
}

/** find 가 본문에 정확히 한 번 있을 때만 바꾼다 → { text } | { error } */
export function replaceOnce(text, find, replacement) {
  const n = text.split(find).length - 1;
  if (n === 0) return { error: 'find 가 본문에 없어요' };
  if (n > 1) return { error: `find 가 본문에 ${n}번 있어요 (한 번만 있는 글로 적어 주세요)` };
  return { text: text.replace(find, () => replacement) };
}

/** 메모 끝에 줄을 바꿔 덧붙인다 */
export const appendText = (body, add) => `${body.trim()}\n${add.trim()}`;

/**
 * 시트 CSV 한 번 처리: 처리할 줄마다 apply(job) → { id } | { error } 를 부르고 결과를 적은 새 CSV (처리할 것이 없으면 null)
 *   apply 가 던지면 그 줄만 error 로 (나머지는 그대로 처리) — PC 는 core/src/sheet_inbox.rs run
 */
export function runSheet(csv, apply) {
  const rows = rowsFromCsv(csv);
  const todo = plan(rows);
  if (!todo.length) return null;
  const results = todo.map(({ index, job, error }) => {
    if (error) return { index, error };
    try {
      const r = apply(job);
      return r?.error ? { index, error: r.error } : { index, id: r.id };
    } catch (err) {
      return { index, error: `처리하지 못했어요 (${err?.message ?? err})` };
    }
  });
  return { csv: rowsToCsv(finish(rows, results)), done: results.filter((r) => !r.error).length };
}
