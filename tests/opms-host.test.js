import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpmsHost, Opms, DEFAULT_HOST } from '../desktop/opms.js';

test('OPMS: 서버 주소는 코드에 없고, 사용자가 넣은 주소를 다듬어 쓴다', async () => {
  assert.equal(DEFAULT_HOST, '');
  assert.equal(normalizeOpmsHost('192.168.0.10:8181'), 'http://192.168.0.10:8181');
  assert.equal(normalizeOpmsHost(' https://opms.local:8443/ '), 'https://opms.local:8443');
  assert.equal(normalizeOpmsHost('ftp://x'), null);
  assert.equal(normalizeOpmsHost('http://user:pw@x'), null, '비밀번호 넣은 주소는 받지 않음');
  assert.equal(normalizeOpmsHost(''), null);
  let called = false;
  const o = new Opms({ host: '', fetch: async () => { called = true; } });
  await assert.rejects(() => o.find('P2026-0001'), /서버 주소를 먼저 넣어/);
  assert.equal(called, false, '주소가 없으면 어디에도 묻지 않음');
});
