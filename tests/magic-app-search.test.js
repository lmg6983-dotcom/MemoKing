import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileIndex } from '../desktop/file-index.js';
import { actionsFor } from '../app/js/magic-actions.js';

test('FileIndex.searchSplit: 프로그램 바로가기(app: true)는 apps 배열로 분리되어 나온다', () => {
  const idx = new FileIndex();
  idx.use([
    { n: '카카오톡.lnk', p: 'C:\\Users\\me\\Programs\\카카오톡.lnk', d: false, a: true, depth: 1 },
    { n: '카카오페이 증권 영수증.pdf', p: 'C:\\Users\\me\\Documents\\카카오페이 증권 영수증.pdf', d: false, a: false, depth: 2 },
    { n: '카카오 관련 폴더', p: 'C:\\Users\\me\\Documents\\카카오 관련 폴더', d: true, a: false, depth: 2 },
    { n: 'Chrome.lnk', p: 'C:\\ProgramData\\Programs\\Chrome.lnk', d: false, a: true, depth: 1 },
  ], Date.now());

  const split = idx.searchSplit('카카오', { apps: 2, folders: 2, files: 2 });

  // 1. apps 항목 검증
  assert.equal(split.apps.length, 1);
  assert.equal(split.apps[0].name, '카카오톡'); // .lnk 확장자는 제거됨
  assert.equal(split.apps[0].app, true);
  assert.equal(split.totalApps, 1);

  // 2. folders 항목 검증
  assert.equal(split.folders.length, 1);
  assert.equal(split.folders[0].name, '카카오 관련 폴더');
  assert.equal(split.folders[0].isDir, true);
  assert.equal(split.totalFolders, 1);

  // 3. files 항목 검증 (앱은 files에서 제외됨)
  assert.equal(split.files.length, 1);
  assert.equal(split.files[0].name, '카카오페이 증권 영수증.pdf');
  assert.equal(split.files[0].app, false);
  assert.equal(split.files[0].isDir, false);
  assert.equal(split.totalFiles, 1);
});

test('magic-actions: kind가 app인 줄의 액션은 실행(Enter), 폴더 열기, 경로 복사 순서이다', () => {
  const acts = actionsFor({ kind: 'app', name: '카카오톡', path: 'C:\\Programs\\카카오톡.lnk' });
  assert.deepEqual(acts, [
    { id: 'open', label: '실행' },
    { id: 'reveal', label: '폴더 열기', key: 'Ctrl+Shift+E' },
    { id: 'copyPath', label: '경로 복사', key: 'Ctrl+Shift+C' },
  ]);
});
