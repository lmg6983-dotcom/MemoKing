// 그림 PDF 만들기 (makeImagePdf) — xref 가 객체 자리를 바르게 가리키는가 (1바이트만 틀려도 뷰어에 따라 "깨진 파일")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImagePdf } from '../app/js/pdf-engine.js';

test('makeImagePdf: 쪽 수 · xref 자리 · 쪽 비율', () => {
  const jpeg = (n) => ({ bytes: new Uint8Array(n).fill(0xff), w: 1240, h: 1754 });
  const out = makeImagePdf([jpeg(300), jpeg(17), { bytes: new Uint8Array(5), w: 1000, h: 500 }]);
  const text = Buffer.from(out).toString('latin1');
  assert.match(text, /^%PDF-1\.4\n/);
  assert.match(text, /\/Type \/Pages \/Count 3 \/Kids \[3 0 R 6 0 R 9 0 R\]/);
  assert.match(text, /\/MediaBox \[0 0 595 298\]/); // 1000×500 → 595 폭
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(start, start + 5), 'xref\n');
  const [, count] = /^xref\n0 (\d+)\n/.exec(text.slice(start));
  assert.equal(Number(count), 12);
  const rows = text.slice(start).split('\n').slice(3, 3 + 11);
  rows.forEach((row, i) => {
    const at = Number(row.slice(0, 10));
    assert.equal(text.slice(at, at + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `객체 ${i + 1}`);
  });
  assert.match(text, /\/Size 12 \/Root 1 0 R/);
});
