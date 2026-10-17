// PC 동기화 진행 글 · 로그인 오류 판정 (app/js/drive-panel.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressText, etaText, progressFraction, needsLogin } from '../app/js/drive-panel.js';

test('진행 글: 살펴보기 → n/총 · 남은 시간', () => {
  assert.equal(progressText(null), '');
  assert.equal(progressText({ phase: 'scan' }), 'Drive 폴더 살펴보는 중…');
  const since = 1_000_000;
  assert.equal(progressText({ phase: 'transfer', done: 1, total: 40, since }, since + 1000), '파일 1/40개 맞추는 중', '처음에는 남은 시간을 말하지 않는다');
  assert.equal(progressText({ phase: 'transfer', done: 10, total: 40, since }, since + 30_000), '파일 10/40개 맞추는 중 · 약 2분 남음');
  assert.equal(etaText({ phase: 'transfer', done: 30, total: 40, since }, since + 30_000), '곧 끝나요');
  assert.equal(etaText({ phase: 'transfer', done: 20, total: 40, since }, since + 40_000), '1분 안에 끝나요');
  assert.equal(etaText({ phase: 'transfer', done: 40, total: 40, since }, since + 40_000), '');
  assert.equal(progressFraction({ phase: 'scan' }), null);
  assert.equal(progressFraction({ phase: 'transfer', done: 10, total: 40 }), 0.25);
  assert.equal(progressFraction({ phase: 'transfer', done: 0, total: 0 }), 1);
});

test('다시 로그인할 오류만 "다시 로그인" (Drive 폴더 권한 오류는 아님)', () => {
  assert.ok(needsLogin('Google Drive 로그인이 끊겼어요. 설정에서 다시 연결해 주세요'));
  assert.ok(needsLogin('Google Drive에 로그인해 주세요'));
  assert.ok(needsLogin('Google 로그인 오류: invalid_grant'));
  assert.ok(!needsLogin('Google Drive가 허락하지 않았어요: The user does not have sufficient permissions'));
  assert.ok(!needsLogin('Drive 전체 권한을 허용하지 않았어요'));
  assert.ok(!needsLogin('인터넷에 연결되지 않아 동기화하지 못했어요'));
});
