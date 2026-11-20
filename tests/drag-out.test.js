import { test } from 'node:test';
import assert from 'node:assert/strict';

// 창마다 같은 저장소 (localStorage) 흉내
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { rememberDragOut, isOwnDragOut } = await import('../app/js/core/drag-out.js');
const dropped = (...names) => ({ files: names.map((name) => ({ name })) });

test('메모킹에서 끌어낸 파일이 도로 떨어지면 취소 (한 번만)', () => {
  rememberDragOut('보고서.docx');
  assert.equal(isOwnDragOut(dropped('보고서.docx')), true);
  assert.equal(isOwnDragOut(dropped('보고서.docx')), false, '알아본 뒤에는 지운다 — 다음에 같은 이름을 끌어 오면 보통 넣기');
});

test('다른 파일 · 오래 지난 끌기는 보통 넣기', () => {
  rememberDragOut('사진.png');
  assert.equal(isOwnDragOut(dropped('다른.png')), false);
  assert.equal(isOwnDragOut(dropped('사진.png'), Date.now() + 3 * 60 * 1000), false, '2분이 지나면 다른 데서 끌어 온 것으로');
  assert.equal(isOwnDragOut(null), false);
  assert.equal(isOwnDragOut({ files: [] }), false);
});
