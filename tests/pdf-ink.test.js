// PDF 주석 · 글자 (PDFium wasm) — 주석을 PDF 에 넣고 다시 열면 그대로 꺼내지는가 · 두 번 저장해도 겹치지 않는가 · 글자를 고르고 꺼내는가
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

globalThis.location ??= { protocol: 'http:' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  if (!String(u).startsWith('file:')) return realFetch(u);
  try {
    return new Response(readFileSync(fileURLToPath(String(u))));
  } catch {
    return new Response('', { status: 404 });
  }
};
const { openPdf } = await import('../app/js/pdf-engine.js');

// 글자가 든 한 쪽짜리 PDF (Helvetica — 글꼴 파일 없이도 PDFium 이 안다)
function samplePdf() {
  const content = 'BT /F1 24 Tf 72 700 Td (Hello MemoKing) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let s = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

test('PDF 주석: 넣고 → 다시 꺼내기 → 두 번 저장해도 하나씩', async () => {
  const pen = { tool: 'pen', color: '#e5484d', size: 4, pen: false, pts: [[100, 100, 0.5], [200, 150, 0.5], [300, 120, 0.5]] };
  const hl = { tool: 'highlighter', color: '#ffd43b', size: 20, pen: false, pts: [[72, 85, 0.5], [250, 85, 0.5]] };
  const a = await openPdf(samplePdf());
  assert.deepEqual(a.takeInk(0), []);
  const once = a.save(new Map([[0, [pen, hl]]]));
  a.close();
  const b = await openPdf(once);
  const got = b.takeInk(0);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], pen);
  assert.equal(got[1].tool, 'highlighter');
  const twice = b.save(new Map([[0, got]]));
  b.close();
  const c = await openPdf(twice);
  assert.equal(c.takeInk(0).length, 2);
  c.close();
});

test('PDF 글자: 누른 자리의 글자 · 낱말 · 꺼내기 · 칠할 네모', async () => {
  const pdf = await openPdf(samplePdf());
  const t = pdf.text(0);
  assert.equal(t.text(0, t.count - 1), 'Hello MemoKing');
  const k = t.charAt(80, 792 - 705); // "Hello" 의 첫 글자 근처 (왼쪽 위 기준 pt)
  assert.ok(k >= 0 && k <= 1, `글자 번호 ${k}`);
  assert.equal(t.text(...t.word(k)), 'Hello');
  assert.equal(t.charAt(500, 500), -1);
  const [r] = t.rects(0, 4);
  assert.ok(r.x > 70 && r.x < 75 && r.y > 70 && r.y < 92 && r.w > 40, JSON.stringify(r));
  assert.equal(t.textIn({ x: 60, y: 60, w: 400, h: 50 }).trim(), 'Hello MemoKing'); // 네모 안의 글
  assert.equal(t.textIn({ x: 60, y: 300, w: 100, h: 50 }), '');
  pdf.close();
});
