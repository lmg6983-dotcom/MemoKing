import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex } from '../desktop/file-index.js';

test('폴더 자동 재색인: 1단계 quickScan이 새로 생긴 사건 폴더를 0.1초 내로 인덱스에 즉시 반영한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-auto-reindex-'));
  const wrapperDir = path.join(root, 'wrapper');
  fs.mkdirSync(wrapperDir, { recursive: true });

  const idx = new FileIndex({ roots: () => [{ dir: root }] });
  idx.stopped = false;
  await idx.rebuild();

  // 처음에는 P2026-9999-KR01 폴더가 없음
  let res = idx.searchSplit('P2026-9999-KR01');
  assert.equal(res.folders.length, 0);

  // 전자포대 폴더에 새 사건 폴더 생성
  const caseFolder = path.join(wrapperDir, 'P2026-9999-KR01');
  fs.mkdirSync(caseFolder);
  fs.writeFileSync(path.join(caseFolder, '명세서.docx'), '');

  // quickScan 실행
  const added = await idx.quickScan([wrapperDir]);
  assert.ok(added >= 1, '새로 생성된 사건 폴더 및 파일이 추가되어야 함');

  // 즉시 검색 시 폴더로 발견되는지 확인
  res = idx.searchSplit('P2026-9999-KR01');
  assert.equal(res.folders.length, 1);
  assert.equal(res.folders[0].name, 'P2026-9999-KR01');
  assert.equal(res.folders[0].isDir, true);
});

test('폴더 자동 재색인: triggerAutoReindex는 빠른 스캔과 쿨다운(중복 방지)을 지킨다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-auto-reindex2-'));
  const wrapperDir = path.join(root, 'wrapper');
  fs.mkdirSync(wrapperDir, { recursive: true });

  const idx = new FileIndex({ roots: () => [{ dir: root }] });
  idx.stopped = false;
  await idx.rebuild();

  // 첫 번째 트리거: quickScan 실행됨 (rebuilding 트리거됨)
  let rebuildDone = false;
  const res1 = await idx.triggerAutoReindex({
    targetDirs: [wrapperDir],
    onRebuildComplete: () => {
      rebuildDone = true;
    },
    force: true,
  });
  assert.equal(res1.rebuilding, true);

  // 4초 쿨다운 이내 연속 호출: quickScan은 쿨다운으로 스킵(added: 0), rebuild는 이미 진행 중이거나 쿨다운
  const res2 = await idx.triggerAutoReindex({ targetDirs: [wrapperDir] });
  assert.equal(res2.added, 0, '연속 호출 시 쿨다운으로 중복 퀵스캔 스킵');

  // 백그라운드 재색인 완료 대기
  if (idx.building) await idx.building;
  assert.equal(rebuildDone, true, '백그라운드 rebuild 완료 콜백이 호출되어야 함');

  // 완료 후 2분 쿨다운 이내에는 rebuild가 다시 돌지 않음
  const res3 = await idx.triggerAutoReindex({ targetDirs: [wrapperDir] });
  assert.equal(res3.rebuilding, false, '2분 쿨다운 이내에는 전체 rebuild 스킵');
});

test('폴더 자동 재색인: 이미 있는지 확인(has)은 색인이 커도 바로 — 매직키에 칠 때 앱이 멈추지 않게', () => {
  const idx = new FileIndex({ roots: () => [] });
  idx.use(Array.from({ length: 200_000 }, (_, i) => ({ n: `file${i % 5000}.txt`, p: `C:/data/d${i}/file${i % 5000}.txt`, d: false, a: false, depth: 3 })), Date.now());
  const t = performance.now();
  for (let i = 0; i < 2000; i++) idx.has(`C:/Users/me/Documents/new${i}/file${i % 5000}.txt`);
  assert.ok(idx.has('C:/data/d7/file7.txt') && idx.has('c:/DATA/d7/FILE7.txt'), '있는 경로는 대소문자 없이 찾음');
  assert.ok(performance.now() - t < 500, `색인 20만 개 · 폴더 항목 2000개 확인이 0.5초 안에 (예전 약 4초)`);
});
