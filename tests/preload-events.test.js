import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 화면이 구독하는 이벤트는 모두 preload 의 허용 목록에 있어야 한다 — 빠지면 preload 가 "알 수 없는 이벤트" 를 던져
//   그 줄 아래 화면 코드가 통째로 멈춘다 (v0.64.0 ~ v0.68.0 의 목록 창 멈춤, ai:tagging)
const root = path.join(import.meta.dirname, '..');
const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'vendor' ? [] : listFiles(p);
  return d.name.endsWith('.js') ? [p] : [];
});

test('화면이 듣는 이벤트는 모두 preload 허용 목록에 있다', () => {
  // 다른 창(매직키 · 파일 찾기 · OPMS · OCR)의 preload 는 onShow 같은 함수로만 주고, 화면의 api.on(…) 은 이 목록을 거친다
  const list = /const EVENTS = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8'))[1];
  const allowed = new Set([...list.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const missing = [];
  for (const file of listFiles(path.join(root, 'app', 'js'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\.on\('([a-z-]+:[a-z:-]+)'/g)) {
      if (!allowed.has(m[1])) missing.push(`${path.relative(root, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'desktop/preload.cjs 의 EVENTS 에 넣어 주세요');
});
