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

test('OPMS: 예전 설치에서 옮겨 오기 — 이 PC 의 받은 기록에서 가장 많이 쓴 서버 · 전자포대 폴더', async () => {
  const { opmsSettingsFromRecords } = await import('../desktop/opms.js');
  const path = (await import('node:path')).win32;
  const recs = [
    { '#seq': 3, 'http://10.1.2.3:8181|g:\\drive\\포대\\p2026-0001': {}, 'http://10.1.2.3:8181|g:\\drive\\포대\\p2026-0002': {} },
    { 'http://old:80|c:\\x\\p1': {} },
  ];
  assert.deepEqual(opmsSettingsFromRecords(recs, { dirname: path.dirname }), { host: 'http://10.1.2.3:8181', wrapperDir: 'g:\\drive\\포대' });
  assert.equal(opmsSettingsFromRecords([{ '#seq': 1 }]), null);
  assert.equal(opmsSettingsFromRecords([]), null);
});
