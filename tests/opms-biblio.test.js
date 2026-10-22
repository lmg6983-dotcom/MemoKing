import { test } from 'node:test';
import assert from 'node:assert/strict';
import { biblioFields, biblioText } from '../app/js/core/opms-biblio.js';

const c = {
  ourref: 'FPD/2026-0271/E', yourref: 'Y-77', div: '특허', applicant: '메모킹 주식회사', inventor: '홍길동',
  d_accept: '2026-01-10 00:00:00.0', n_app: '10-2026-0012345', d_app: '2026-02-03 00:00:00.0', n_issue: '', d_issue: '',
  title_kor: '메모를 쉽게 쓰는 장치', memo: '',
};

test('OPMS 서지사항: 정해진 순서, 날짜는 YYYY-MM-DD, 비고는 있을 때만', () => {
  assert.deepEqual(biblioFields(c).map(([k]) => k), ['사무소관리번호', '출원인관리번호', '구분', '출원인', '발명자', '수임일', '출원번호', '출원일', '등록번호', '등록일', '발명명칭']);
  assert.equal(biblioFields(c).find(([k]) => k === '출원일')[1], '2026-02-03');
  assert.equal(biblioFields({ ...c, memo: '심사 청구 예정' }).at(-1)[1], '심사 청구 예정');
});

test('OPMS 서지사항 전체 복사: "이름 : 값" 줄마다, 빈 값은 -, 여러 줄 비고는 값 자리에 맞춰', () => {
  const text = biblioText({ ...c, memo: '첫 줄\r\n둘째 줄' });
  const lines = text.split('\n');
  assert.equal(lines[0], '사무소관리번호 : FPD/2026-0271/E');
  assert.equal(lines[2], '구분      : 특허');
  assert.ok(lines.includes('등록번호    : -'));
  assert.equal(lines.at(-2), '비고      : 첫 줄');
  assert.equal(lines.at(-1), `${' '.repeat('비고      : '.length)}둘째 줄`);
});
