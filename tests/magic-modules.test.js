import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRef, MAGIC_MODULES, normalizeMagicSettings, activeModules, memoBodyFromText } from '../app/js/core/magic-modules.js';

test('매직키 설정: 기본은 켜짐 · 메모 만들기·메모 검색·파일 검색 켜짐, 준비 중 모듈은 늘 꺼짐', () => {
  const s = normalizeMagicSettings(undefined);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.modules, { memo: true, notes: true, files: true, calc: false, opms: true });
  const forced = normalizeMagicSettings({ enabled: false, modules: { memo: false, files: false, calc: true, opms: true, everything: true } });
  assert.deepEqual(forced, { enabled: false, modules: { memo: false, notes: true, files: false, calc: false, opms: true } });
});

test('매직키: 켜진 모듈만, 매직키를 끄면 없음', () => {
  assert.deepEqual(activeModules({}).map((m) => m.id), ['memo', 'notes', 'files', 'opms']);
  assert.deepEqual(activeModules({ modules: { memo: false, notes: false, files: false, opms: false } }), []);
  assert.deepEqual(activeModules({ enabled: false }), []);
  assert.ok(MAGIC_MODULES.every((m) => m.id && m.name && m.description));
});

test('매직키 OPMS: 관리번호·출원번호처럼 보일 때만 회사 서버에 묻는다', () => {
  assert.ok(looksLikeRef('FPD/2026-0271/E') && looksLikeRef('1020260012345') && looksLikeRef('P-1234'));
  assert.ok(!looksLikeRef('회의록') && !looksLikeRef('a1') && !looksLikeRef('첫 줄\n2026'));
});

test('매직키 → 메모 본문: 앞 빈 줄·끝 공백은 빼고 줄바꿈은 그대로', () => {
  assert.equal(memoBodyFromText('\n\n  회의 3시\r\n자료 챙기기  \n\n'), '  회의 3시\n자료 챙기기');
  assert.equal(memoBodyFromText('   '), '');
});
