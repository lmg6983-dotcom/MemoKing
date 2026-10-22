import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRef, MAGIC_MODULES, normalizeMagicSettings, activeModules, memoBodyFromText, magicChips, toggleMagicChip } from '../app/js/core/magic-modules.js';

test('매직키 설정: 기본은 켜짐 · 모든 기능 켜짐, 모르는 기능은 버림 · 기본 사이트는 네이버 · ChatGPT', () => {
  const s = normalizeMagicSettings(undefined);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.modules, { memo: true, notes: true, files: true, calc: true, web: true, ai: true, opms: true });
  assert.equal(s.engine, 'naver');
  assert.equal(s.ai, 'chatgpt');
  const known = ['memo', 'notes', 'files', 'calc', 'web', 'ai', 'opms'];
  const forced = normalizeMagicSettings({ enabled: false, modules: { memo: false, files: false, calc: false, opms: true, everything: true }, engine: 'google', ai: 'nope', known });
  assert.deepEqual(forced, { enabled: false, modules: { memo: false, notes: true, files: false, calc: false, web: true, ai: true, opms: true }, paused: {}, engine: 'google', ai: 'chatgpt', known });
  // 예전 설정: 계산기는 "준비 중"이라 false 로 저장돼 있었다 → 고른 값이 아니니 기본(켜짐)으로, 다른 기능은 고른 그대로
  const old = normalizeMagicSettings({ modules: { memo: true, notes: false, files: true, calc: false, opms: false } });
  assert.deepEqual(old.modules, { memo: true, notes: false, files: true, calc: true, web: true, ai: true, opms: false });
  assert.equal(normalizeMagicSettings(old).modules.calc, true); // 한 번 저장한 뒤에도
  assert.equal(normalizeMagicSettings({ ...old, modules: { ...old.modules, calc: false } }).modules.calc, false); // 이제 끈 것은 꺼진 채
});

test('매직키: 켜진 모듈만, 매직키를 끄면 없음', () => {
  assert.deepEqual(activeModules({}).map((m) => m.id), ['memo', 'notes', 'files', 'calc', 'web', 'ai', 'opms']);
  assert.deepEqual(activeModules({ modules: { memo: false, notes: false, files: false, calc: false, web: false, ai: false, opms: false }, known: ['memo', 'notes', 'files', 'calc', 'web', 'ai', 'opms'] }), []);
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

test('매직키 창 캡슐: 설정에서 켠 기능만 보이고, 누르면 잠깐 끄고 켬 — 설정에서 끈 기능은 켤 수 없음', () => {
  const settings = { modules: { opms: false, calc: false, web: false, ai: false }, known: ['opms', 'calc', 'web', 'ai'] };
  assert.deepEqual(magicChips(settings).map((m) => m.id), ['memo', 'notes', 'files']); // OPMS 는 캡슐도 없음
  const off = toggleMagicChip(settings, 'files');
  assert.deepEqual(magicChips(off).map((m) => `${m.id}:${m.on}`), ['memo:true', 'notes:true', 'files:false']);
  assert.deepEqual(activeModules(off).map((m) => m.id), ['memo', 'notes']);
  assert.deepEqual(activeModules(toggleMagicChip(off, 'files')).map((m) => m.id), ['memo', 'notes', 'files']);
  assert.deepEqual(toggleMagicChip(settings, 'opms').modules.opms, false); // 설정에서 끈 것은 매직키 창에서 켜지지 않음
  assert.deepEqual(normalizeMagicSettings({ modules: { opms: false }, paused: { opms: true } }).paused, {}); // 끈 기능의 잠깐 끔은 남기지 않음
  assert.deepEqual(magicChips({ enabled: false }), []);
});
