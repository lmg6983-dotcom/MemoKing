import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrorLog, problemMail } from '../desktop/error-log.js';

test('오류 기록: 한 줄씩 (여러 줄은 한 줄로), 최근 것부터 꺼내기, 크면 .1 로 옮기고 새로', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-log-'));
  try {
    const log = createErrorLog(path.join(dir, 'logs', 'memoking.log'), { now: () => new Date('2026-10-24T00:00:00Z') });
    log.write('첫 오류');
    log.write('둘째\n  at list.js:10');
    assert.deepEqual(log.tail(), ['2026-10-24T00:00:00.000Z 첫 오류', '2026-10-24T00:00:00.000Z 둘째 ⏎ at list.js:10']);
    assert.deepEqual(log.tail(1), ['2026-10-24T00:00:00.000Z 둘째 ⏎ at list.js:10']);
    fs.appendFileSync(log.file, 'x'.repeat(600 * 1024));
    log.write('새 파일');
    assert.ok(fs.existsSync(`${log.file}.1`));
    assert.deepEqual(log.tail(), ['2026-10-24T00:00:00.000Z 새 파일']);
    assert.deepEqual(createErrorLog(path.join(dir, 'none.log')).tail(), [], '기록이 없으면 빈 목록');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('문제 보내기 메일: 버전 · 운영체제 · 들어가는 만큼의 최근 기록 (오래된 줄부터 뺀다)', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `줄 ${i} 알 수 없는 이벤트`);
  const url = problemMail({ to: 'a@b.c', version: '0.70.0', os: 'Windows_NT 10.0', lines });
  assert.ok(url.startsWith('mailto:a@b.c?subject='));
  assert.ok(url.length <= 2000);
  const body = decodeURIComponent(url.split('&body=')[1]);
  assert.match(body, /메모킹 v0\.70\.0 · Windows_NT 10\.0/);
  assert.match(body, /줄 79 알 수 없는 이벤트/, '가장 최근 줄은 남는다');
  assert.doesNotMatch(body, /줄 0 /, '오래된 줄부터 뺀다');
  assert.match(decodeURIComponent(problemMail({ to: 'a@b.c', version: '1', os: 'x', lines: [] })), /기록된 오류 없음/);
});
