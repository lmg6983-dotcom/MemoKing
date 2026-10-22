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
  put('사건/P20261170KR01 의견서.docx');
  put('사건/FPD-2026080118-E 보고.pdf');
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
  // 관리번호: 기호를 넣어 찾아도 붙여 쓴 이름, 기호가 다른 이름도
  assert.equal(idx.search('P2026-1170-KR01')[0]?.name, 'P20261170KR01 의견서.docx');
  assert.equal(idx.search('FPD/202608-0118/E')[0]?.name, 'FPD-2026080118-E 보고.pdf');
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

test('파일 검색: 몇 개만 보여 줘도 맞는 것 전체 개수를 센다 (나머지는 "다른 n건" → 모두 찾기 창)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-index-many-'));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `견적서 ${String(i).padStart(2, '0')}.xlsx`), '');
  fs.mkdirSync(path.join(root, '견적서 모음'));
  fs.writeFileSync(path.join(root, '다른 문서.txt'), '');
  const idx = new FileIndex({ roots: () => [{ dir: root }] });
  idx.stopped = false;
  await idx.rebuild();
  const split = idx.searchSplit('견적서', { folders: 3, files: 6 });
  assert.equal(split.files.length, 6);
  assert.equal(split.totalFiles, 30);
  assert.equal(split.totalFolders, 1);
  // 모두 찾기 창: 비슷한 것부터 전부
  const all = idx.searchAll('견적서', 2000);
  assert.equal(all.total, 31);
  assert.equal(all.items.length, 31);
  assert.equal(all.items[0].name, '견적서 모음'); // 얕고 짧은 이름이 먼저
  assert.equal(idx.searchAll('없는말', 10).total, 0);
});

test('파일 검색: 받은 전자포대는 새로 고침을 기다리지 않고 곧바로 찾힌다 (새로 고침 뒤에도 남음)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-wrap-'));
  const index = new FileIndex({ roots: () => [{ dir: root }] });
  index.stopped = false;
  await index.rebuild();
  const dir = path.join(root, 'P2026-1170-KR01');
  fs.mkdirSync(dir);
  const file = path.join(dir, '의견제출통지서.pdf');
  fs.writeFileSync(file, '');
  assert.equal(index.search('의견제출통지서').length, 0, '새로 고침 전에는 없음');
  assert.equal(index.add([dir, file], { base: root }), 2);
  assert.equal(index.add([file], { base: root }), 0, '두 번 넣지 않음');
  assert.equal(index.search('의견제출통지서')[0]?.path, file);
  assert.equal(index.search('P20261170KR01')[0]?.path, dir, '사건 폴더도');
  // 훑는 도중에 넣은 것도 새 목록에 이어 붙는다 (새 목록이 이미 본 것은 한 번만)
  const crawl = index.crawl.bind(index);
  index.crawl = async () => { const e = await crawl(); index.add([path.join(dir, 'late.pdf')]); return e; };
  fs.writeFileSync(path.join(dir, 'late.pdf'), '');
  await index.rebuild();
  assert.equal(index.search('의견제출통지서').length, 1);
  assert.equal(index.search('late.pdf').length, 1);
  index.stop();
});

test('파일 검색: 지켜보는 폴더에 생긴 파일은 곧바로 목록에', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-watch-'));
  const index = new FileIndex({ roots: () => [] });
  index.watch([root]);
  fs.mkdirSync(path.join(root, '사건'));
  fs.writeFileSync(path.join(root, '사건', '거절결정서.pdf'), '');
  fs.writeFileSync(path.join(root, '사건', '받는중.crdownload'), '');
  const deadline = Date.now() + 5000;
  while (!index.search('거절결정서').length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  index.stop();
  assert.equal(index.search('거절결정서').length, 1);
  assert.equal(index.search('받는중').length, 0, '받는 중인 파일은 빼고');
});

test('초성으로도 찾음 (ㅎㅇㄹ → 회의록, 띄어쓰기 건너뜀) · 첫머리가 맞는 것이 앞', () => {
  const idx = new FileIndex({ roots: () => [] });
  idx.use([
    { n: '9월 회의록.hwp', p: 'C:/a/9월 회의록.hwp', d: false, a: false, depth: 2 },
    { n: '회의록 모음', p: 'C:/a/회의록 모음', d: true, a: false, depth: 1 },
    { n: '견적서 01.txt', p: 'C:/a/견적서 01.txt', d: false, a: false, depth: 1 },
  ], Date.now());
  const names = idx.search('ㅎㅇㄹ').map((r) => r.name);
  assert.deepEqual(names.sort(), ['9월 회의록.hwp', '회의록 모음'].sort());
  assert.equal(idx.search('ㅎㅇㄹ')[0].name, '회의록 모음', '초성 첫머리가 맞는 것이 앞');
  assert.deepEqual(idx.search('ㄱㅈㅅ 01').map((r) => r.name), ['견적서 01.txt'], '초성 + 글자 섞어도');
  assert.deepEqual(idx.search('ㅎㅇㄹㅁㅇ').map((r) => r.name), ['회의록 모음'], '띄어쓰기 건너뜀');
  assert.deepEqual(idx.search('ㅋㅋ'), []);
});

test('이어 친 글은 앞에서 맞은 이름 안에서만 찾아도 처음부터 찾은 것과 같음 (지우거나 바꾸면 처음부터)', () => {
  const names = ['견적서 01.txt', '견적 메모.hwp', '견본 사진.jpg', '회의록 견적.docx', 'estimate-2026.xlsx', 'P2026-1170-KR01.pdf', '견적서 모음'];
  const entries = names.map((n, k) => ({ n, p: `C:/a/${k}/${n}`, d: !n.includes('.'), a: false, depth: 1 }));
  const fresh = (q) => { const x = new FileIndex({ roots: () => [] }); x.use(entries, Date.now()); return x.searchAll(q, 20); };
  const idx = new FileIndex({ roots: () => [] });
  idx.use(entries, Date.now());
  for (const q of ['견', '견적', '견적서', '견적서 0', 'ㄱ', 'ㄱㅈ', 'ㄱㅈㅅ', 'e', 'est', '견', '견본', 'p2026', 'p2026-1170']) {
    assert.deepEqual(idx.searchAll(q, 20), fresh(q), q);
  }
});
