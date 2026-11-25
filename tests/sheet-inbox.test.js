// AI 받은함 시트: 휴대폰 메모 폴더(android/web/js/vault.js applySheetJob)에 네 가지 요청을 적용하고 결과를 status 에 적는다
//   (같은 규칙의 PC 는 desktop-rs/core/src/vault/sheet_inbox.rs, 읽기 · 쓰기 · 고르기는 tests/parity.rs sheet_inbox)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(`export function resolve(s, c, next) {
  if (c.parentURL?.includes('/android/web/js/') && s.startsWith('../../app/')) s = new URL('../../../' + s.slice(6), c.parentURL).href;
  return next(s, c);
}`)}`);

const files = new Map();
let clock = 1_000;
const stat = (rel) => (files.has(rel) ? { name: rel.split('/').pop(), dir: false, mtime: files.get(rel).mtime, size: Buffer.byteLength(files.get(rel).text) } : null);
const put = (rel, text) => {
  files.set(rel, { text, mtime: ++clock });
  return stat(rel);
};
const ok = (v) => JSON.stringify({ v: v ?? null });
globalThis.window = {
  MemoKingNative: {
    scan: () => ok([...files.keys()].filter((r) => r.endsWith('.md') && !r.startsWith('_memoking/')).map((file) => ({ file, mtime: files.get(file).mtime, size: stat(file).size }))),
    list: (dir) => ok([...files.keys()].filter((r) => r.startsWith(dir ? `${dir}/` : '') && !r.slice(dir ? dir.length + 1 : 0).includes('/')).map(stat)),
    stat: (rel) => ok(stat(rel)),
    readText: (rel) => ok(files.get(rel)?.text),
    writeText: (rel, text) => ok(put(rel, text)),
    writeTextIf: (rel, text, mtime, size) => {
      const s = stat(rel);
      return !s || s.mtime !== mtime || s.size !== size ? ok({ changed: true }) : ok(put(rel, text));
    },
    mkdirs: () => ok(null),
    move: (a, b) => (files.has(b) || !files.has(a) ? ok(false) : (files.set(b, files.get(a)), files.delete(a), ok(true))),
    remove: (rel) => ok(files.delete(rel)),
  },
};

test('네 가지 요청을 적용하고 잠긴 메모 · 없는 메모 · 겹친 글은 거절한다', async () => {
  const { Vault } = await import('../android/web/js/vault.js');
  const { runSheet, rowsFromCsv } = await import('../app/js/core/sheet-inbox.js');
  put('회의.md', '---\nid: m1\n---\n# 회의\n월요일\n');
  put('비밀.md', '---\nid: lk\n---\n# 비밀\n\n<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->\n');
  const vault = new Vault();
  vault.open();
  try {
    const csv = [
      'req_id,action,memo_id,folder,color,body,find,status',
      '1,create,,업무,,"# 새 메모\n첫 줄",,pending',
      '1b,create,,업무,blue,"# 파란 메모\n본문",,pending',
      '1c,create,,,rainbow,"# 이상한 색",,pending',
      '2,append,m1,,,화요일,,pending',
      '3,replace,m1,,,수요일,화요일,pending',
      '4,replace,m1,,,x,없는 글,pending',
      '5,append,lk,,,몰래,,pending',
      '6,trash,없는-id,,,,,pending',
      '7,create,,../밖,,# x,,pending',
    ].join('\r\n');
    const out = runSheet(csv, (job) => vault.applySheetJob(job));
    const status = rowsFromCsv(out.csv).map((r) => r.status);
    assert.equal(out.done, 4);
    assert.match(status[0], /^done \(.+\)$/);
    assert.match(status[1], /^done \(.+\)$/);
    assert.deepEqual(status.slice(2), [
      'error: 쓸 수 없는 color 예요 (yellow · green · pink · purple · blue · gray · charcoal 중 하나)',
      'done (m1)', 'done (m1)', 'error: find 가 본문에 없어요', 'error: 잠긴 메모는 고칠 수 없어요', 'error: 그런 memo_id 의 메모가 없어요', 'error: 쓸 수 없는 folder 예요 (/ \\ .. _memoking 은 안 돼요)',
    ]);
    assert.match(files.get('업무/새 메모.md').text, /color: yellow/, 'color 를 비우면 기본값 노란색(yellow)');
    assert.match(files.get('업무/새 메모.md').text, /# 새 메모\n첫 줄/, '폴더 안에 첫 줄 제목으로');
    assert.match(files.get('업무/파란 메모.md').text, /color: blue/, '지정한 색(blue)으로 생성');
    assert.match(files.get('회의.md').text, /# 회의\n월요일\n수요일/);
    assert.ok([...files.keys()].some((r) => r.startsWith('_memoking/versions/m1/')), '고치기 전 글은 버전으로');
    assert.match(files.get('비밀.md').text, /memoking-lock/, '잠긴 메모는 그대로');
    assert.equal(runSheet(out.csv, () => assert.fail('다시 처리하지 않는다')), null, '처리한 줄은 다시 하지 않는다');
    const trash = runSheet(`${out.csv}8,trash,m1,,,,,pending\r\n`, (job) => vault.applySheetJob(job));
    assert.equal(rowsFromCsv(trash.csv).at(-1).status, 'done (m1)');
    assert.ok(!files.has('회의.md') && [...files.keys()].some((r) => r.startsWith('_memoking/trash/회의')), '휴지통으로');
  } finally {
    vault.close();
  }
});
