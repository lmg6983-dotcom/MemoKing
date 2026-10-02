import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_MODULES, normalizeMagicSettings, activeModules, memoBodyFromText } from '../app/js/core/magic-modules.js';

test('매직키 설정: 기본은 켜짐 · 메모 모듈만 켜짐, 준비 중 모듈은 늘 꺼짐', () => {
  const s = normalizeMagicSettings(undefined);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.modules, { memo: true, calc: false, everything: false, opms: false });
  const forced = normalizeMagicSettings({ enabled: false, modules: { memo: false, calc: true, opms: true, unknown: true } });
  assert.deepEqual(forced, { enabled: false, modules: { memo: false, calc: false, everything: false, opms: false } });
});

test('매직키: 켜진 모듈만, 매직키를 끄면 없음', () => {
  assert.deepEqual(activeModules({}).map((m) => m.id), ['memo']);
  assert.deepEqual(activeModules({ modules: { memo: false } }), []);
  assert.deepEqual(activeModules({ enabled: false }), []);
  assert.ok(MAGIC_MODULES.every((m) => m.id && m.name && m.description));
});

test('매직키 → 메모 본문: 앞 빈 줄·끝 공백은 빼고 줄바꿈은 그대로', () => {
  assert.equal(memoBodyFromText('\n\n  회의 3시\r\n자료 챙기기  \n\n'), '  회의 3시\n자료 챙기기');
  assert.equal(memoBodyFromText('   '), '');
});
