import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalize, sqlQuote, cleanDate, parseResultset, buildLookupSql, buildForeignSqls, mergeForeign, foreignSummary,
  wrapperFolderName, safeFilename, fileSizeLabel, attachmentItems, caseInfoText, caseMemoMarkdown, looksLikeRef, Opms,
  buildAttachSql, groupSchema, pickDetailTables, buildDetailSql, detailRows, noveltyColumnsOf,
} from '../desktop/opms.js';

// 서버 응답 모양: 1줄 열 이름 · 2~4줄 정보 · 5줄부터 자료 (\x01 로 나눔)
const table = (cols, rows) => [cols.join('\x01'), 'meta', 'meta', 'meta', ...rows.map((r) => r.join('\x01'))].join('\n');

test('OPMS: 응답 값 다듬기 · 표 읽기', () => {
  assert.equal(normalize('null'), '');
  assert.equal(normalize(' "따옴표" '), '따옴표');
  assert.equal(cleanDate('2025-10-31 00:00:00.0'), '2025-10-31');
  assert.equal(sqlQuote("O'Brien"), "O''Brien");
  const rows = parseResultset(table(['idx', 'ourref', 'memo'], [['1', 'FPD/2026-0271/E', 'null'], ['2', '"P-1"']]));
  assert.deepEqual(rows, [{ idx: '1', ourref: 'FPD/2026-0271/E', memo: '' }, { idx: '2', ourref: 'P-1', memo: '' }]);
  assert.throws(() => parseResultset('oops'), /형식/);
});

test('OPMS: 관리번호·출원번호로 찾는 SQL (하이픈 없이 · 앞자리 생략 · 따옴표 막기)', () => {
  const s13 = buildLookupSql('1020260012345');
  assert.match(s13, /n_app = '10-2026-0012345'/);
  assert.match(s13, /ourref = '1020260012345' OR yourref = '1020260012345'/);
  assert.match(buildLookupSql('20260173230'), /n_app LIKE '%-2026-0173230'/);
  assert.match(buildLookupSql('2026-0173230'), /n_app LIKE '%-2026-0173230'/);
  assert.match(buildLookupSql("x' OR '1'='1"), /ourref = 'x'' OR ''1''=''1'/);
  assert.match(buildLookupSql('FPD/2026-0271/E'), /WHERE del_flag = 'N' AND \(ourref = 'FPD\/2026-0271\/E'/);
  assert.ok(looksLikeRef('FPD/2026') && looksLikeRef('2026-0173230'));
  assert.ok(!looksLikeRef('회의') && !looksLikeRef('abc') && !looksLikeRef('12'));
});

test('OPMS: 해외출원 세 길을 하나로 · 요약', () => {
  const sqls = buildForeignSqls({ idx: '7', ourref: 'P-1', n_app: '10-2026-0012345' });
  assert.equal(sqls.length, 3);
  assert.match(sqls[0], /P\.n_pri IN \('10-2026-0012345', '1020260012345'\)/);
  const merged = mergeForeign([
    [{ ourref: 'A', app_ncode: 'US', n_app: '1', d_app: '2026-01-02 00:00:00.0' }],
    [{ ourref: 'A', app_ncode: 'US', n_app: '1' }, { ourref: 'B', app_ncode: '', _div: 'PCT', n_app: '2' }],
  ]);
  assert.deepEqual(merged.map((f) => [f.ourref, f.app_ncode, f.d_app]), [['A', 'US', '2026-01-02'], ['B', 'PCT', '']]);
  assert.equal(foreignSummary({}, merged), '해외 2건 (US, PCT)');
  assert.equal(foreignSummary({ ck_out: 'Y' }, []), '해외출원 예정');
});

test('OPMS: 전자포대 폴더·파일 이름', () => {
  assert.equal(wrapperFolderName({ ourref: 'FPD/2026-0271/E', yourref: '10-2026-0012345' }), 'FPD20260271E_1020260012345');
  assert.equal(wrapperFolderName({ ourref: '', yourref: '' }, 'P 1'), 'P1');
  assert.equal(safeFilename('../a:b?.pdf', 'x'), '_a_b_.pdf');
  assert.equal(safeFilename('', 'fallback.bin'), 'fallback.bin');
  assert.equal(fileSizeLabel(2048), '2.0 KB');
  assert.equal(fileSizeLabel(''), '-');
  const items = attachmentItems([
    { FILE_NAME_UPLOAD: 'up/1.pdf', FILE_NAME_ORI: '출원서.pdf', DOC_NAME: '출원서', registered_at: '2026-01-02 10:00:00', FILE_SIZE: '1048576' },
    { FILE_NAME_UPLOAD: '', FILE_NAME_ORI: '빈 것' },
  ]);
  assert.deepEqual(items, [{ n: 1, date: '2026-01-02', doc: '출원서', name: '출원서.pdf', size: '1.0 MB', upload: 'up/1.pdf' }]);
  const txt = caseInfoText({ ourref: 'P-1', applicant: '메모킹' }, { files: items, now: new Date(2026, 0, 2, 3, 4, 5) });
  assert.match(txt, /\[OPMS 사건 정보\] P-1 \/ -/);
  assert.match(txt, /출원인\s+: 메모킹/);
  assert.match(txt, /1\. 출원서\.pdf \(1\.0 MB\)/);
  assert.match(txt, /생성일시: 2026-01-02 03:04:05/);
});

test('OPMS: 서버와 주고받기 (찾기 · 전자포대 받기 · 사건정보.txt)', async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? new URLSearchParams(init.body) : null });
    if (url.endsWith('/servlet/Jbori')) {
      const sql = new URLSearchParams(init.body).get('sql');
      if (/FROM opms_app/.test(sql)) return new Response(table(['idx', 'ourref', 'yourref', 'n_app'], [['7', 'P/1', 'Y-1', '10-2026-0012345']]));
      return new Response(table(['idx'], []));
    }
    if (url.includes('/OPMS/up/')) return new Response(Buffer.from('PDFDATA'));
    return new Response('', { status: 404 });
  };
  const opms = new Opms({ host: 'http://opms.test/', fetch: fakeFetch, retries: 0 });
  const [c] = await opms.find('1020260012345');
  assert.equal(c.ourref, 'P/1');
  const posted = calls[0].body;
  assert.equal(posted.get('connection'), 'easypnp');
  assert.equal(posted.get('command'), 'SELECT');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-opms-'));
  const items = [{ n: 1, name: '출원서.pdf', size: '7 B', upload: 'up/1.pdf' }, { n: 2, name: '없음.pdf', size: '-', upload: 'missing/2.pdf' }];
  const res = await opms.download(c, items, { baseDir: base, all: true });
  assert.equal(res.dir, path.join(base, 'P1_Y1'));
  assert.equal(fs.readFileSync(path.join(res.dir, '출원서.pdf'), 'utf8'), 'PDFDATA');
  assert.deepEqual([res.saved, res.skipped, res.failed.length], [1, 0, 1]);
  assert.match(fs.readFileSync(path.join(res.dir, '사건정보.txt'), 'utf8'), /1\. 출원서\.pdf/);
  // 두 번째는 이미 있는 파일을 건너뛴다
  const again = await opms.download(c, items.slice(0, 1), { baseDir: base });
  assert.deepEqual([again.saved, again.skipped], [0, 1]);
  // 서버가 없으면 알아듣게
  const off = new Opms({ fetch: async () => { throw new Error('ECONNREFUSED'); }, retries: 0 });
  await assert.rejects(off.find('P-1234'), (e) => e.offline && /사내망/.test(e.message));
});

test('OPMS: 사건 정보 → 메모 (제목 · 서지 표 · 업무배분 · 해외출원 · #OPMS)', () => {
  const md = caseMemoMarkdown(
    { ourref: 'FPD/2026-0271/E', title_kor: '메모 | 장치', applicant: '메모킹', d_app: '2026-01-02 00:00:00.0', memo: '' },
    { mywork: [{ div_job: '출원', per_name: '홍길동', per_gubun: '변리사', d_due: '2026-02-01 00:00:00.0', detail: '첫 줄\n둘째 줄' }], foreign: [{ app_ncode: 'US', _div: 'PCT', n_app: 'US1' }], summary: 'US' },
  );
  assert.match(md, /^# FPD\/2026-0271\/E 메모 \| 장치\n/);
  assert.match(md, /\| 출원일 \| 2026-01-02 \|/);
  assert.match(md, /\| 발명명칭 \| 메모 \\\| 장치 \|/);
  assert.doesNotMatch(md, /비고/);
  assert.match(md, /## 업무배분[\s\S]*\| 출원 \| 홍길동\(변리사\) \| - \| 2026-02-01 \| - \| 첫 줄 둘째 줄 \|/);
  assert.match(md, /## 해외출원[\s\S]*\| US \| PCT \|/);
  assert.match(md, /\n#OPMS\n$/);
});

test('OPMS 더 보기: 표 이름으로 신규성 의제 · 진행사항 · 메모 표 고르기 (사건으로 이어지는 표만)', () => {
  const schema = groupSchema([
    ...['idx', 'ourref', 'memo', 'ck_novelty', 'd_novelty'].map((c) => ({ TABLE_NAME: 'opms_app', COLUMN_NAME: c })),
    ...['idx', 'idx_app', 'd_pub', 'content', 'del_flag'].map((c) => ({ TABLE_NAME: 'opms_app_novelty', COLUMN_NAME: c })),
    ...['idx', 'idx_parent', 'd_proc', 'status', 'memo', 'del_flag'].map((c) => ({ TABLE_NAME: 'opms_app_progress', COLUMN_NAME: c })),
    ...['idx', 'idx_parent', 'd_proc', 'status'].map((c) => ({ TABLE_NAME: 'view_opms_app_progress', COLUMN_NAME: c })),
    ...['idx', 'idx_app', 'memo', 'reg_name', 'd_reg', 'upd_date'].map((c) => ({ TABLE_NAME: 'opms_app_memo', COLUMN_NAME: c })),
    ...['idx', 'memo'].map((c) => ({ TABLE_NAME: 'opms_memo_template', COLUMN_NAME: c })), // 사건과 이어지지 않음
    { TABLE_NAME: 'opms_bad;drop', COLUMN_NAME: 'idx_app' }, // 이상한 이름은 버림
  ]);
  const picks = pickDetailTables(schema);
  assert.deepEqual(picks.novelty && [picks.novelty.table, picks.novelty.link], ['opms_app_novelty', 'idx_app']);
  assert.equal(picks.progress.table, 'opms_app_progress'); // 보기(view_)보다 원래 표
  assert.equal(picks.memo.table, 'opms_app_memo');
  assert.deepEqual(noveltyColumnsOf(schema), ['ck_novelty', 'd_novelty']);
  assert.equal(buildDetailSql(picks.progress, "7'"), "SELECT TOP 200 * FROM [opms_app_progress] WHERE [idx_parent] = '7''' AND [del_flag] = 'N' ORDER BY [idx] ASC");
  assert.deepEqual(pickDetailTables(groupSchema([{ TABLE_NAME: 'opms_app', COLUMN_NAME: 'idx' }])), { novelty: null, progress: null, memo: null });
});

test('OPMS 더 보기: 보일 열만 (번호·삭제 표시·바꾼 때·빈 열은 빼고, 날짜는 YYYY-MM-DD)', () => {
  const out = detailRows([
    { idx: '1', idx_app: '7', memo: '첫 줄\n둘째 줄', reg_name: '홍길동', d_reg: '2026-01-02 10:00:00.0', upd_date: '2026-01-03', del_flag: 'N', empty: '' },
    { idx: '2', idx_app: '7', memo: '회신', reg_name: '김철수', d_reg: '2026-02-01 00:00:00.0', upd_date: '', del_flag: 'N', empty: '' },
  ]);
  assert.deepEqual(out.columns, [{ key: 'memo', label: '메모' }, { key: 'reg_name', label: '쓴 사람' }, { key: 'd_reg', label: '등록일' }]);
  assert.deepEqual(out.rows[0], { memo: '첫 줄 둘째 줄', reg_name: '홍길동', d_reg: '2026-01-02' });
  assert.deepEqual(detailRows([]), { columns: [], rows: [] });
});

test('OPMS 더 보기: 서버에서 표 목록 → 고른 표 → 메모에도', async () => {
  const sqls = [];
  const fakeFetch = async (url, init = {}) => {
    const sql = new URLSearchParams(init.body).get('sql');
    sqls.push(sql);
    if (/INFORMATION_SCHEMA/.test(sql)) return new Response(table(['TABLE_NAME', 'COLUMN_NAME'], [['opms_app', 'idx'], ['opms_app', 'd_novelty'], ['opms_app_memo', 'idx'], ['opms_app_memo', 'idx_app'], ['opms_app_memo', 'memo']]));
    if (/FROM \[opms_app_memo\]/.test(sql)) return new Response(table(['idx', 'idx_app', 'memo'], [['1', '7', '심사관 면담 예정']]));
    if (/SELECT \[d_novelty\] FROM opms_app/.test(sql)) return new Response(table(['d_novelty'], [['2025-12-01 00:00:00.0']]));
    return new Response(table(['x'], []));
  };
  const client = new Opms({ fetch: fakeFetch, retries: 0 });
  const d = await client.details({ idx: '7' });
  assert.deepEqual(d.sections.find((x) => x.id === 'memo').rows, [{ memo: '심사관 면담 예정' }]);
  assert.deepEqual(d.novelty, [{ label: '의제일', value: '2025-12-01' }]);
  assert.deepEqual(d.missing, ['신규성 의제', '진행사항']); // 표로는 없음 (신규성 의제는 사건 표의 칸으로 보임)
  await client.details({ idx: '7' });
  assert.equal(sqls.filter((q) => /INFORMATION_SCHEMA/.test(q)).length, 1); // 표 목록은 한 번만
  const md = caseMemoMarkdown({ ourref: 'P-1' }, { details: d });
  assert.match(md, /## 신규성 의제\n\n\| 항목 \| 내용 \|\n\| --- \| --- \|\n\| 의제일 \| 2025-12-01 \|/);
  assert.match(md, /## 메모\n\n\| 메모 \|\n\| --- \|\n\| 심사관 면담 예정 \|/);
});

test('OPMS 전자포대: 최신순으로 받아 위에 새 서류 · No. 는 오래된 것부터 1', () => {
  assert.match(buildAttachSql('7'), /ORDER BY registered_at DESC, IDX DESC/);
  const items = attachmentItems([
    { FILE_NAME_UPLOAD: 'up/3.pdf', FILE_NAME_ORI: '의견서.pdf', registered_at: '2026-03-01' },
    { FILE_NAME_UPLOAD: '', FILE_NAME_ORI: '빈 줄' },
    { FILE_NAME_UPLOAD: 'up/1.pdf', FILE_NAME_ORI: '출원서.pdf', registered_at: '2026-01-02' },
  ]);
  assert.deepEqual(items.map((x) => `${x.n}:${x.name}`), ['2:의견서.pdf', '1:출원서.pdf']);
});

test('OPMS 진행사항: 받은 서류·낸 서류를 한 줄씩 (최신이 위, 순서·부서 코드는 빼고)', async () => {
  const { progressItems, dueState } = await import('../app/js/core/opms-progress.js');
  const items = progressItems([
    { no_rec: '-', d_rec: '-', rec_memo: '인용참증(29조2항), 기재불비(42조4항2호)', n_extend: '0', d_pre: '2026-07-13', pre_doc: '우선심사신청서', clerk: '이민균', part_code: '600900', pre_div: '특허청', reg_per: '이태정', d_reg: '2026-07-15', sort: '1' },
    { no_rec: '9520260664921 68', d_rec: '2026-07-23', d_noti: '2026-07-22', rec_doc: '우선심사결정서', sort: '2' },
    { no_rec: '952026085686456', d_rec: '2026-09-17', d_noti: '2026-09-16', rec_doc: '의견제출통지서', n_extend: '0', d_due: '2027-01-16', clerk: '이민균', part_code: '600900', sort: '3' },
  ]);
  assert.deepEqual(items.map((x) => `${x.date} ${x.kind} ${x.title}`), ['2026-09-16 수신 의견제출통지서', '2026-07-22 수신 우선심사결정서', '2026-07-13 제출 우선심사신청서']);
  assert.equal(items[0].due, '2027-01-16');
  assert.deepEqual(items[0].meta, [['접수번호', '952026085686456'], ['접수일', '2026-09-17'], ['담당', '이민균']]);
  assert.deepEqual(items[2].meta, [['제출처', '특허청'], ['담당', '이민균']]);
  assert.match(items[2].memo, /인용참증/);
  const now = new Date(2026, 11, 20);
  assert.deepEqual(['2026-12-01', '2027-01-10', '2027-06-01', ''].map((d) => dueState(d, now)), ['past', 'soon', 'later', '']);
  const md = caseMemoMarkdown({ ourref: 'P-1' }, { details: { novelty: [], sections: [{ id: 'progress', label: '진행사항', rows: [{ d_noti: '2026-09-16', rec_doc: '의견제출통지서', d_due: '2027-01-16', clerk: '이민균' }] }] } });
  assert.match(md, /## 진행사항\n\n- 2026-09-16 \*\*수신\*\* 의견제출통지서 \(기한 2027-01-16\) — 담당 이민균\n/);
});
