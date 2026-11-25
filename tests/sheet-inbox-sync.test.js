// AI 받은함 시트를 휴대폰이 처리하는 흐름 (android/web/js/sheet-inbox.js): 가짜 Drive 시트로
//   ① 처리하는 사이 AI 가 줄을 더하면 덮어쓰지 않고(낙관적 잠금) ② 다음 차례에 같은 요청을 다시 적용하지 않으며 ③ 새 줄까지 처리한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(`export function resolve(s, c, next) {
  if (c.parentURL?.includes('/android/web/js/') && s.startsWith('../../app/')) s = new URL('../../../' + s.slice(6), c.parentURL).href;
  return next(s, c);
}`)}`);

const HEAD = 'req_id,action,memo_id,folder,body,find,status\r\n';
const drive = { csv: `${HEAD}1,create,,,# 장보기,,pending\r\n`, version: 1, exports: 0, onUpdate: null };
const stamp = () => `v${drive.version}`;
const native = {
  sheetInbox({ op, since, stamp: seen, csv }) {
    if (op === 'fetch') {
      if (since === stamp()) return { id: 's1', stamp: stamp() };
      drive.exports++;
      return { id: 's1', stamp: stamp(), csv: drive.csv };
    }
    drive.onUpdate?.();
    drive.onUpdate = null;
    if (seen !== stamp()) return { changed: true };
    drive.csv = csv;
    drive.version++;
    return { ok: true };
  },
};
globalThis.localStorage = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
globalThis.window = {
  MemoKingNative: {
    call: (id, method, args) => setTimeout(() => window.__mk.resolve(id, JSON.stringify({ v: native[method](JSON.parse(args)) })), 0),
  },
};

test('처리하는 사이 줄이 늘면 덮어쓰지 않고, 다음 차례에 중복 없이 마저 처리한다', async () => {
  const { processSheet } = await import('../android/web/js/sheet-inbox.js');
  const { rowsFromCsv } = await import('../app/js/core/sheet-inbox.js');
  const made = [];
  const vault = { applySheetJob: (job) => (made.push(job.body), { id: `m${made.length}` }) };
  // 1차례: 처리 · 결과를 적기 직전에 AI 가 줄을 더함 → 덮어쓰지 않는다
  drive.onUpdate = () => {
    drive.csv += '2,create,,,# 할 일,,pending\r\n';
    drive.version++;
  };
  await processSheet(vault);
  assert.deepEqual(made, ['# 장보기']);
  assert.match(drive.csv, /1,create,,,# 장보기,,pending/, 'AI 가 더한 줄을 지우지 않게 덮어쓰지 않았다');
  // 2차례: 다시 읽어 1번은 기억한 결과만 적고(다시 만들지 않음) 2번은 처리
  assert.equal(await processSheet(vault), 2);
  assert.deepEqual(made, ['# 장보기', '# 할 일'], '같은 요청으로 메모가 둘 생기지 않는다');
  assert.deepEqual(rowsFromCsv(drive.csv).map((r) => r.status), ['done (m1)', 'done (m2)']);
  // 3차례: 덮어쓴 뒤 한 번 더 읽고 · 4차례: 그대로면 내려받지 않는다
  await processSheet(vault);
  const exports = drive.exports;
  assert.equal(await processSheet(vault), 0);
  assert.equal(drive.exports, exports, '시트가 그대로면 CSV 를 다시 받지 않는다');
});
