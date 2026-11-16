// 충돌 사본 이름 → 원본 이름 (PC · 휴대폰 "원본과 견주기")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalFileOf } from '../app/js/core/conflicts.js';

test('충돌 사본 이름에서 원본 이름을 찾는다', () => {
  assert.equal(originalFileOf('회의 (PC 충돌 2026-11-15 1530).md'), '회의.md');
  assert.equal(originalFileOf('업무/회의 (휴대폰 충돌 2026-11-15 1530 2).md'), '업무/회의.md');
  assert.equal(originalFileOf('회의 (2).md'), null);
  assert.equal(originalFileOf('회의 (PC 충돌 메모).md'), null);
  assert.equal(originalFileOf(''), null);
});

// PDF 썸네일: 그림 설명의 "pdf <경로>" 가 가리키는 PDF 도 그 메모의 첨부로 센다
import { extractAttachments, pdfOfTitle, pdfThumbTitle } from '../app/js/core/memo-file.js';
test('PDF 썸네일이 가리키는 PDF 도 첨부로 센다', () => {
  assert.equal(pdfOfTitle(pdfThumbTitle('attachments/보고서.pdf')), 'attachments/보고서.pdf');
  assert.equal(pdfOfTitle('album'), null);
  const body = '# 회의\n\n[보고서.hwp](attachments/보고서.hwp)\n\n![보고서](attachments/보고서-thumb.png "pdf attachments/보고서.pdf")\n';
  assert.deepEqual(extractAttachments(body), ['attachments/보고서.hwp', 'attachments/보고서-thumb.png', 'attachments/보고서.pdf']);
});
