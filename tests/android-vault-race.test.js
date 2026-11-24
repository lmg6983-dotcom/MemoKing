// 휴대폰 메모 저장: "그대로인지 확인" 과 쓰기 사이에 Drive 동기화가 받은 파일로 바꿔치기해도 그 글을 덮어쓰지 않는다
//   (android/web/js/vault.js write → Bridge.writeTextIf, 확인 + 쓰기를 동기화 잠금 안에서 한 번에)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// 휴대폰 화면 파일의 '../../app/js/…' 는 앱 안에서 저장소의 app/js 를 가리킨다 (android/web 에서 두 칸 위가 아니라)
register(`data:text/javascript,${encodeURIComponent(`export function resolve(s, c, next) {
  if (c.parentURL?.includes('/android/web/js/') && s.startsWith('../../app/')) s = new URL('../../../' + s.slice(6), c.parentURL).href;
  return next(s, c);
}`)}`);

const files = new Map(); // 메모 폴더 기준 경로 → { text, mtime }
let clock = 1_000;
let beforeWrite = null; // writeTextIf 가 확인하기 직전에 한 번 (동기화의 바꿔치기)
const stat = (rel) => {
  const f = files.get(rel);
  return f ? { name: rel.split('/').pop(), dir: false, mtime: f.mtime, size: Buffer.byteLength(f.text) } : null;
};
const put = (rel, text) => {
  files.set(rel, { text, mtime: ++clock });
  return stat(rel);
};
const ok = (v) => JSON.stringify({ v: v ?? null });
const under = (dir) => [...files.keys()].filter((r) => r.startsWith(dir ? `${dir}/` : '') && !r.slice(dir ? dir.length + 1 : 0).includes('/'));
globalThis.window = {
  MemoKingNative: {
    scan: () => ok([...files.keys()].filter((r) => r.endsWith('.md') && !r.startsWith('_memoking/')).map((file) => ({ file, mtime: files.get(file).mtime, size: stat(file).size }))),
    list: (dir) => ok(under(dir).map(stat)),
    stat: (rel) => ok(stat(rel)),
    readText: (rel) => ok(files.get(rel)?.text),
    writeText: (rel, text) => ok(put(rel, text)),
    writeTextIf: (rel, text, mtime, size) => {
      beforeWrite?.();
      beforeWrite = null;
      const s = stat(rel);
      return !s || s.mtime !== mtime || s.size !== size ? ok({ changed: true }) : ok(put(rel, text));
    },
    mkdirs: () => ok(null),
    move: (a, b) => (files.has(b) ? ok(false) : (files.set(b, files.get(a)), files.delete(a), ok(true))),
    remove: (rel) => ok(files.delete(rel)),
  },
};

test('확인과 쓰기 사이에 들어온 다른 기기의 글은 사본으로 남는다', async () => {
  const { Vault } = await import('../android/web/js/vault.js');
  put('회의.md', '---\nid: m1\n---\n# 회의\n처음 글\n');
  const vault = new Vault();
  vault.open();
  try {
    assert.ok(vault.get('m1'), '메모를 읽었다');
    beforeWrite = () => put('회의.md', '---\nid: m1\n---\n# 회의\nPC 에서 고친 글\n'); // 동기화가 PC 의 글로 바꿔치기
    vault.save('m1', '# 회의\n휴대폰에서 고친 글');
    assert.match(files.get('회의.md').text, /휴대폰에서 고친 글/, '휴대폰 글은 저장된다');
    const kept = [...files.entries()].filter(([, f]) => /PC 에서 고친 글/.test(f.text)).map(([r]) => r);
    assert.ok(kept.length > 0, `PC 의 글도 어딘가(사본 · 버전)에 남는다: ${[...files.keys()].join(', ')}`);
  } finally {
    vault.close();
  }
});
