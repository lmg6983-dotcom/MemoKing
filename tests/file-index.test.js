import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex, skipDir, defaultRoots } from '../desktop/file-index.js';

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-index-'));
  const put = (rel) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); };
  put('문서/2026 분기 보고서.docx');
  put('문서/회의록/9월 회의록.hwp');
  put('Downloads/setup_memoking.exe');
  put('사진/제주 여행/IMG_0001.jpg');
  put('node_modules/pkg/index.js');
  put('.git/config');
  put('프로젝트/깊은/곳/아주/깊은/보고서 초안.txt');
  return root;
}

test('파일 검색: 이름 목록을 만들고 철자가 조금 달라도 찾는다 (숨김·node_modules 는 뺌)', async () => {
  const root = tree();
  const idx = new FileIndex({ roots: () => [{ dir: root }] });
  idx.stopped = false;
  await idx.rebuild();
  const names = idx.entries.map((e) => e.n);
  assert.ok(names.includes('2026 분기 보고서.docx') && names.includes('회의록'));
  assert.ok(!names.includes('index.js') && !names.includes('config'), '숨김·node_modules 제외');
  assert.equal(idx.search('분기 보고서')[0].name, '2026 분기 보고서.docx');
  assert.equal(idx.search('setupmemo')[0].name, 'setup_memoking.exe'); // 띄어 쓰지 않고 붙여 써도
  assert.ok(idx.search('회의록').some((r) => r.isDir && r.name === '회의록'));
  // 이름이 찾는 말로 시작하면 앞으로 (깊은 곳에 있어도), 둘 다 찾음
  const r = idx.search('보고서').map((x) => x.name);
  assert.deepEqual(r, ['보고서 초안.txt', '2026 분기 보고서.docx']);
  // 비슷하면 얕은 곳이 먼저
  const r2 = idx.search('회의록').map((x) => x.name);
  assert.equal(r2[0], '회의록');
  assert.deepEqual(idx.search(''), []);
  // 폴더는 따로: '여행' → 폴더 칸에 '제주 여행'
  const split = idx.searchSplit('여행');
  assert.deepEqual(split.folders.map((r) => r.name), ['제주 여행']);
  assert.ok(split.files.every((r) => !r.isDir));
});

test('파일 검색: 저장한 목록을 불러와 바로 찾는다', async () => {
  const root = tree();
  const cacheFile = path.join(root, 'cache', 'file-index.json');
  const a = new FileIndex({ cacheFile, roots: () => [{ dir: root }] });
  a.stopped = false;
  await a.rebuild();
  const b = new FileIndex({ cacheFile, roots: () => [] });
  b.load();
  assert.equal(b.count, a.count);
  assert.equal(b.search('제주')[0].name, '제주 여행');
});

test('파일 검색: 들어가지 않을 폴더 · 찾을 곳 순서', () => {
  for (const n of ['node_modules', '.git', '$Recycle.Bin', 'Windows', 'Program Files', 'AppData']) assert.equal(skipDir(n), true, n);
  for (const n of ['문서', 'Downloads', 'Projects']) assert.equal(skipDir(n), false, n);
  const roots = defaultRoots({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' }, exists: (p) => /^(C:\\|D:\\|C:\\Users\\me|.*Programs)$/.test(p) });
  assert.deepEqual(roots.map((r) => [r.dir, Boolean(r.app)]), [
    ['C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs', true],
    ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs', true],
    ['C:\\Users\\me', false], ['C:\\', false], ['D:\\', false],
  ]);
});
