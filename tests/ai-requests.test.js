// AI 요청 메모 — 요청을 메모 폴더에 반영 (휴대폰 vault.js aiRequests, PC 는 core/src/vault/ai_ops.rs 같은 시험)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequests, applyOps, requestsText, findMemo } from '../app/js/core/ai-requests.js';
import { extractTitle } from '../app/js/core/memo-file.js';

function fakeVault() {
  let n = 0;
  const versions = [];
  const v = {
    entries: new Map(),
    versions,
    create({ color, folder = '' } = {}) {
      const id = `m${++n}`;
      v.entries.set(id, { id, file: null, folder, body: '', meta: { color: color ?? 'yellow' } });
      return id;
    },
    save(id, body) {
      const e = v.entries.get(id);
      e.body = body;
      e.file ??= `${e.folder ? `${e.folder}/` : ''}${extractTitle(body)}.md`;
    },
    setMeta: (id, patch) => Object.assign(v.entries.get(id).meta, patch),
    moveToFolder(id, dir) {
      const e = v.entries.get(id);
      e.file = `${dir ? `${dir}/` : ''}${e.file.slice(e.file.lastIndexOf('/') + 1)}`;
    },
    trash: (id) => v.entries.delete(id),
    keepVersion: (id, before) => versions.push([id, before]),
  };
  return v;
}

test('요청을 반영하고, 같은 요청을 다시 받으면 이미 됨', () => {
  const v = fakeVault();
  const a = v.create();
  v.save(a, '# OA 프롬프트\n\n본문 길게\n\n#ETRI #공유');
  const b = v.create();
  v.save(b, '# 덧붙일 메모\n둘째 글');
  const ops = [
    { do: 'tag', memo: 'OA 프롬프트.md', add: ['프롬프트'], remove: ['ETRI', '공유'] },
    { do: 'color', memo: a, color: 'blue' },
    { do: 'move', memo: a, folder: '프롬프트' },
    { do: 'merge', into: a, from: [b] },
    { do: 'create', text: '# 새 메모\n본문', folder: '할일' },
    { do: 'replace', memo: a, find: '없는 글', with: 'x' },
    { do: 'tag', memo: '없는.md', add: ['x'] },
  ];
  const parsed = parseRequests(`\`\`\`json\n${JSON.stringify(ops)}\n\`\`\``).ops;
  const lines = applyOps(v, parsed);
  assert.ok(lines.slice(0, 5).every((l) => l.startsWith('- ✅')), lines.join('\n'));
  assert.match(lines[5], /^- ⚠️ 글 바꾸기 · OA 프롬프트 — 바꿀 글을 찾지/);
  assert.match(lines[6], /^- ⚠️ 태그 · 없는\.md — 메모를 찾지/);
  const m = v.entries.get(a);
  assert.equal(m.meta.color, 'blue');
  assert.ok(m.body.includes('#프롬프트') && !m.body.includes('#ETRI') && m.body.includes('둘째 글'));
  assert.equal(m.file, '프롬프트/OA 프롬프트.md');
  assert.ok(!v.entries.has(b), '합친 메모는 휴지통으로');
  assert.ok(v.versions.length >= 1, '고치기 전 글은 지난 버전으로');
  assert.ok([...v.entries.values()].some((e) => e.file === '할일/새 메모.md'));
  const again = applyOps(v, parsed.slice(0, 5));
  assert.ok(again.every((l) => l.startsWith('- ➖')), again.join('\n'));
});

test('잠긴 메모 · 비밀 메모는 고치지 않는다', () => {
  const v = fakeVault();
  v.entries.set('s', { id: 's', file: null, secret: 'f1', body: '# 비밀', meta: {} });
  const [line] = applyOps(v, parseRequests('```json\n[{"do":"trash","memo":"s"}]\n```').ops);
  assert.match(line, /잠긴 메모는 고치지 않아요/);
  assert.ok(v.entries.has('s'));
});

test('결과를 적은 글은 다시 읽어도 할 일이 없다', () => {
  assert.deepEqual(parseRequests(requestsText(['- ✅ a'], '2026-11-23 17:04')), { ops: [], error: '' });
  assert.equal(findMemo([{ id: 'x', file: 'a/b.md' }, { id: 'y', file: 'c/b.md' }], 'b.md'), null, '이름이 둘이면 고르지 않는다');
});
