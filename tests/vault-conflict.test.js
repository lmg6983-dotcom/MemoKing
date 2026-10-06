import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';

// 자동 저장이 아직 알아채지 못한 다른 기기(동기화)의 변경을 몰래 덮어쓰지 않는다 — 그쪽 내용은 사본 메모로
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-conflict-'));
  const vault = new Vault(dir);
  vault.open();
  const id = vault.import({ body: '# 회의 메모\n\n처음 내용' });
  const file = path.join(dir, vault.entries.get(id).file);
  return { dir, vault, id, file };
}
const mdFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
// 다른 기기가 파일을 바꾼 것처럼: 내용을 바꾸고 수정 시각도 확실히 다르게
function writeExternally(file, text) {
  fs.writeFileSync(file, text);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

test('동시 수정: 알아채기 전 바뀐 파일을 덮어쓰기 전에 그쪽 내용을 사본으로 남긴다', () => {
  const { dir, vault, id, file } = setup();
  try {
    const original = fs.readFileSync(file, 'utf8');
    writeExternally(file, original.replace('처음 내용', 'PC에서 고친 내용'));
    vault.save(id, '# 회의 메모\n\n휴대폰에서 고친 내용');
    assert.match(fs.readFileSync(file, 'utf8'), /휴대폰에서 고친 내용/);
    const copies = mdFiles(dir).filter((f) => f.includes('다른 기기'));
    assert.equal(copies.length, 1, mdFiles(dir).join(', '));
    const copy = fs.readFileSync(path.join(dir, copies[0]), 'utf8');
    assert.match(copy, /^# 회의 메모 \(다른 기기 /m);
    assert.match(copy, /PC에서 고친 내용/);
  } finally {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('동시 수정: 시각만 바뀌고 내용이 같으면 사본을 만들지 않는다', () => {
  const { dir, vault, id, file } = setup();
  try {
    writeExternally(file, fs.readFileSync(file, 'utf8'));
    vault.save(id, '# 회의 메모\n\n새 내용');
    assert.deepEqual(mdFiles(dir).filter((f) => f.includes('다른 기기')), []);
    // 평소 저장(다른 곳에서 바꾸지 않음)에도 사본 없음
    vault.save(id, '# 회의 메모\n\n또 새 내용');
    assert.equal(mdFiles(dir).length, 1);
  } finally {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
