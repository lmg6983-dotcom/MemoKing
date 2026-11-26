// AI 받은함 시트를 휴대폰이 처리하는 흐름 (android/web/js/sheet-inbox.js): 가짜 Drive 시트로
//   ① 처리하는 사이 AI 가 줄을 더하면 덮어쓰지 않고(낙관적 잠금) ② 다음 차례에 같은 요청을 다시 적용하지 않으며 ③ 새 줄까지 처리한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(`export function resolve(s, c, next) {
  if (c.parentURL?.includes('/android/web/js/') && s.startsWith('../../app/')) s = new URL('../../../' + s.slice(6), c.parentURL).href;
  return next(s, c);
}`)}`);

const HEAD = 'req_id,action,memo_id,folder,color,body,find,status\r\n';
const drive = { csv: `${HEAD}1,create,,,,# 장보기,,pending\r\n`, version: 1, exports: 0, onUpdate: null };
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
    drive.csv += '2,create,,,,# 할 일,,pending\r\n';
    drive.version++;
  };
  await processSheet(vault);
  assert.deepEqual(made, ['# 장보기']);
  assert.match(drive.csv, /1,create,,,,# 장보기,,pending/, 'AI 가 더한 줄을 지우지 않게 덮어쓰지 않았다');
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

test('예전 7열 헤더 시트에 8열 pending 행이 들어와도 자동 보정하고 8열 헤더로 업그레이드한다', async () => {
  const { rowsFromCsv, runSheet, needsHeaderUpgrade } = await import('../app/js/core/sheet-inbox.js');
  const legacyCsv = [
    'req_id,action,memo_id,folder,body,find,status',
    '20261125-01,create,,할일,# 기존 메모,,done (old-1)',
    '20261126-01,create,,AI 리포트(월드),green,# 새 리포트,,pending',
  ].join('\n');
  assert.equal(needsHeaderUpgrade(legacyCsv), true);
  const parsed = rowsFromCsv(legacyCsv);
  assert.equal(parsed[0].status, 'done (old-1)');
  assert.equal(parsed[1].color, 'green');
  assert.equal(parsed[1].body, '# 새 리포트');
  assert.equal(parsed[1].status, 'pending');
  const out = runSheet(legacyCsv, (job) => {
    assert.equal(job.color, 'green');
    return { id: 'new-1' };
  });
  assert.equal(out.done, 1);
  assert.equal(needsHeaderUpgrade(out.csv), false);
  assert.equal(rowsFromCsv(out.csv)[1].status, 'done (new-1)');
});

test('기기 충돌 사본은 inboxLeader 리더 선출에서 제외된다', async () => {
  const { inboxLeader } = await import('../app/js/core/devices.js');
  const now = 1_795_734_268_000;
  const me = { file: '_memoking/기기/SM-F731N (9604).md', kind: 'phone' };
  const conflict = { file: '_memoking/기기/SM-F731N (9604) (휴대폰 충돌 2026-11-27 0134).md', kind: 'phone', alive: now - 10_000 };
  assert.equal(inboxLeader([conflict], me, now), true);
});
