// OPMS 조회 (회사 사건 관리 시스템) — 매직키의 "OPMS 검색" 모듈과 OPMS 창이 쓴다 (PC 전용)
//   opms_lookup_v2.py 를 옮긴 것. 사내망 서버의 /servlet/Jbori 에 SELECT 글을 보내고, 줄마다 \x01 로 나뉜 표를 받는다
//   (1줄 = 열 이름, 2~4줄 = 정보, 5줄부터 = 자료). 전자포대 원본은 <서버>/OPMS/<FILE_NAME_UPLOAD>
//   찾는 말은 모두 따옴표를 겹쳐(') SQL 글 안에 값으로만 넣는다.
import fs from 'node:fs';
import path from 'node:path';
export { looksLikeRef } from '../app/js/core/magic-modules.js';
import { progressItems } from '../app/js/core/opms-progress.js';

export const DEFAULT_HOST = 'http://121.254.172.35:8181';
export const DEFAULT_WRAPPER_DIR = 'G:\\내 드라이브\\work(firstlaw)\\포대';
const JBORI_PATH = '/servlet/Jbori';
const STATIC_PATH = '/OPMS';
const CONNECTION = 'easypnp';
const USER_AGENT = 'memoking-opms/1.0';

export const CASE_COLUMNS = [
  'idx', 'div', 'ourref', 'yourref', 'n_app', 'd_app', 'n_issue', 'd_issue',
  'applicant', 'inventor', 'title_kor', 'd_accept', 'memo', 'ck_out', 'out_div', 'd_out_due', 'd_out',
];
const BILL_COLUMNS = ['idx', 'idx_parent', 'div', 'div_sub', 'd_demand', 'n_demand', 'dem_memo', 'amount', 'amount_off_fee', 'memo', 'ourref', 'n_app', 'n_issue'];

// ---------- 값 다듬기 ----------

/** 응답 값: "null" → '', 앞뒤 큰따옴표 떼기 */
export function normalize(value) {
  if (value == null) return '';
  let s = String(value);
  if (s === 'null') return '';
  s = s.trim();
  if (s === 'null') return '';
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

export const sqlQuote = (value) => (value == null ? '' : String(value).replace(/'/g, "''"));

/** 2025-10-31 00:00:00.0 → 2025-10-31 */
export function cleanDate(d) {
  if (!d) return '';
  const s = String(d).trim();
  return s.length >= 10 && s[4] === '-' && s[7] === '-' ? s.slice(0, 10) : s;
}

/** 응답 글 → [{열: 값}] */
export function parseResultset(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  if (lines.length < 4) throw new Error(`OPMS 응답 형식이 예상과 달라요: ${String(text).slice(0, 200)}`);
  const columns = lines[0].split('\x01');
  const rows = [];
  for (const line of lines.slice(4)) {
    if (!line) continue;
    const values = line.split('\x01');
    rows.push(Object.fromEntries(columns.map((c, i) => [c, normalize(values[i] ?? '')])));
  }
  return rows;
}

// ---------- SQL ----------

/** 관리번호(사무소·출원인) 또는 출원번호(하이픈 있든 없든, 앞자리 생략)로 사건 찾기 */
export function buildLookupSql(query, field = 'both') {
  const raw = String(query ?? '').trim();
  const q = sqlQuote(raw);
  const clean = raw.replace(/[^0-9A-Za-z]/g, '');
  const cands = new Set([raw]);
  if (clean.length === 13 && /^\d+$/.test(clean)) cands.add(`${clean.slice(0, 2)}-${clean.slice(2, 6)}-${clean.slice(6)}`);
  const appConds = [...cands].map((c) => `n_app = '${sqlQuote(c)}'`);
  if (clean.length === 11 && /^\d+$/.test(clean)) appConds.push(`n_app LIKE '%-${sqlQuote(`${clean.slice(0, 4)}-${clean.slice(4)}`)}'`);
  else if (/^\d{4}-\d{7}$/.test(raw)) appConds.push(`n_app LIKE '%-${sqlQuote(raw)}'`);
  const app = appConds.join(' OR ');
  const cond = field === 'our' ? `ourref = '${q}'`
    : field === 'your' ? `yourref = '${q}'`
      : field === 'app' ? `(${app})`
        : `(ourref = '${q}' OR yourref = '${q}' OR ${app})`;
  return `SELECT ${CASE_COLUMNS.join(', ')}\nFROM opms_app\nWHERE del_flag = 'N' AND ${cond}\nORDER BY d_accept DESC, idx DESC`;
}

export const buildCaseByIdxSql = (idx) =>
  `SELECT ${CASE_COLUMNS.join(', ')}\nFROM opms_app\nWHERE del_flag = 'N' AND idx = '${sqlQuote(idx)}'`;

export const buildAttachSql = (groupKey) =>
  'SELECT *,\n       (CASE WHEN USR_DATE IS NOT NULL THEN USR_DATE ELSE REG_DATE END) AS registered_at\nFROM opms_attach\n' +
  `WHERE DELETEFLG = 'N'\n  AND GRP_KEY = '${sqlQuote(groupKey)}'\n  AND ISNULL(DOC_NAME, '') <> 'HDR'\nORDER BY registered_at DESC, IDX DESC`; // 최신순 (위에 새 서류)

export const buildMyworkSql = (caseIdx) =>
  'SELECT W.div_job, W.detail, W.d_rec, W.d_due, W.d_end, W.memo,\n       P.per_name, P.per_gubun\nFROM view_opms_mywork W\n' +
  'LEFT JOIN view_opms_mywork_per P\n  ON P.idx = W.idx AND P.idx_relation = W.idx_relation\n' +
  `WHERE W.del_flag = 'N' AND W.idx_relation = '${sqlQuote(caseIdx)}'\n` +
  "ORDER BY CASE WHEN W.d_end IS NULL OR W.d_end = '' THEN 0 ELSE 1 END,\n         W.d_due ASC, W.idx DESC";

export const buildBillSql = (caseIdx) =>
  `SELECT ${BILL_COLUMNS.join(', ')}\nFROM view_opms_dem_kor\nWHERE del_flag = 'N'\n  AND ck_del = 'N'\n  AND idx_parent IN ('${sqlQuote(caseIdx)}')\n` +
  'ORDER BY idx_parent ASC, d_demand ASC, idx ASC';

/** 해외출원을 찾는 세 가지 길: 우선권 주장 · 패밀리 링크 · 원출원 관리번호 */
export function buildForeignSqls(c) {
  const out = [];
  const nApp = String(c.n_app ?? '').trim();
  const ourref = String(c.ourref ?? '').trim();
  const idx = String(c.idx ?? '').trim();
  if (nApp) {
    const clean = nApp.replace(/[^0-9A-Za-z]/g, '');
    let pri = `'${sqlQuote(nApp)}'`;
    if (clean && clean !== nApp) pri += `, '${sqlQuote(clean)}'`;
    out.push('SELECT DISTINCT\n    F._div, F.idx, F.ourref, F.yourref, F.appref, F.app_ncode,\n    F.d_app, F.n_app, F.d_issue, F.n_issue, F.status, F.attorney_out\n' +
      'FROM opms_out_pri P\nJOIN view_opms_out_family F ON F.idx_parent = P.idx_parent\n' +
      `WHERE P.del_flag = 'N' AND F.del_flag = 'N'\n  AND P.n_pri IN (${pri})\nORDER BY F.app_ncode, F.ourref`);
  }
  if (idx) {
    out.push('SELECT idx, ourref, yourref, appref, app_ncode, d_app, n_app, d_issue, n_issue,\n       status, attorney_out, link_div as _div\n' +
      `FROM view_opms_family_link\nWHERE del_flag = 'N'\n  AND (idx_parent = '${sqlQuote(idx)}' OR idx_link = '${sqlQuote(idx)}')\n` +
      "  AND (link_div NOT IN ('국내', '기타') OR (app_ncode IS NOT NULL AND app_ncode NOT IN ('', 'KR')))\nORDER BY app_ncode, ourref");
  }
  if (ourref) {
    out.push('SELECT _div, idx, ourref, yourref, appref, app_ncode, d_app, n_app, d_issue, n_issue,\n       status, attorney_out\n' +
      "FROM view_opms_out_family\nWHERE del_flag = 'N' AND ourref <> '' AND idx_parent IN (\n" +
      `    SELECT idx FROM opms_out WHERE del_flag = 'N' AND ref_app_ori = '${sqlQuote(ourref)}'\n)\nORDER BY app_ncode, ourref`);
  }
  return out;
}

/** 여러 길로 찾은 해외출원을 하나로 (같은 관리번호·나라·출원번호는 한 번) */
export function mergeForeign(lists) {
  const seen = new Set();
  const out = [];
  for (const rows of lists) {
    for (const r of rows) {
      const key = `${r.ourref}|${r.app_ncode}|${r.n_app}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ncode = String(r.app_ncode ?? '').trim();
      const div = String(r._div ?? '').trim();
      out.push({ ...r, app_ncode: !ncode && ['PCT', 'EP', '마드리드', '헤이그'].includes(div) ? div : ncode, d_app: cleanDate(r.d_app), d_issue: cleanDate(r.d_issue) });
    }
  }
  return out;
}

export function foreignSummary(c, foreign) {
  if (foreign.length) {
    const codes = [...new Set(foreign.map((f) => String(f.app_ncode || f._div || '').trim()).filter(Boolean))];
    const list = codes.slice(0, 5).join(', ') + (codes.length > 5 ? '…' : '');
    return list ? `해외 ${foreign.length}건 (${list})` : `해외 ${foreign.length}건`;
  }
  return c.ck_out === 'Y' ? '해외출원 예정' : '';
}

// ---------- 전자포대 저장 ----------

const folderToken = (t) => String(t ?? '').replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ]+/g, '');

/** 'FPD/2026-0271/E' + '10-2026-0012345' → 'FPD20260271E_1020260012345' */
export function wrapperFolderName(c, fallback = '') {
  const our = folderToken(c.ourref);
  const your = folderToken(c.yourref);
  if (our && your) return `${our}_${your}`;
  return our || your || folderToken(fallback) || 'wrapper';
}

export function safeFilename(name, fallback) {
  const clean = String(name ?? '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').trim();
  return clean || fallback;
}

export function fileSizeLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '-';
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

/** 전자포대 줄 → 화면에 보일 모양 (원본 경로가 없는 줄은 뺀다). 줄은 최신순, No. 는 오래된 것부터 1 (새 서류가 와도 번호가 그대로) */
export function attachmentItems(rows) {
  const kept = rows.filter((r) => String(r.FILE_NAME_UPLOAD ?? '').trim());
  return kept
    .map((r, i) => ({
      n: kept.length - i,
      date: cleanDate(r.registered_at || r.REG_DATE),
      doc: String(r.DOC_NAME || r.DOC_GUBUN || '').trim(),
      name: safeFilename(String(r.FILE_NAME_ORI || r.FILE_NAME || '').trim(), `attachment_${kept.length - i}.bin`),
      size: fileSizeLabel(r.FILE_SIZE),
      upload: String(r.FILE_NAME_UPLOAD).trim(),
    }));
}

const dash = (v) => String(v ?? '').trim() || '-';
const oneLine = (v) => dash(v).replace(/[\r\n]+/g, ' ');

/** 전체를 받을 때 함께 남기는 사건정보.txt */
export function caseInfoText(c, { mywork = [], foreign = [], files = [], now = new Date() } = {}) {
  const L = [];
  const bar = '='.repeat(80);
  L.push(bar, `[OPMS 사건 정보] ${dash(c.ourref)} / ${dash(c.yourref)}`, bar, '', '[기본 서지정보]');
  for (const [k, v] of [
    ['사무소관리번호', c.ourref], ['출원인관리번호', c.yourref], ['구분', c.div], ['출원인', c.applicant], ['발명자', c.inventor],
    ['수임일', cleanDate(c.d_accept)], ['출원번호', c.n_app], ['출원일', cleanDate(c.d_app)], ['등록번호', c.n_issue],
    ['등록일', cleanDate(c.d_issue)], ['발명명칭', c.title_kor], ['비고', c.memo],
  ]) L.push(`  ${k.padEnd(14)} : ${dash(v)}`);
  L.push('', '[업무배분]');
  if (mywork.length) {
    mywork.forEach((r, i) => {
      const per = r.per_gubun ? `${dash(r.per_name)}(${r.per_gubun})` : dash(r.per_name);
      L.push(`  ${i + 1}. ${dash(r.div_job)} | 담당: ${per} | 접수: ${dash(cleanDate(r.d_rec))} | 기한: ${dash(cleanDate(r.d_due))} | 완료: ${dash(cleanDate(r.d_end))} | ${oneLine(r.detail || r.memo)}`);
    });
  } else L.push('  (배분된 업무 없음)');
  L.push('', '[해외출원 현황]');
  if (foreign.length) {
    foreign.forEach((f, i) => L.push(`  ${i + 1}. [${dash(f.app_ncode || f._div)}] ${dash(f._div)} | 우리: ${dash(f.ourref)} | 상대: ${dash(f.yourref)} | 출원: ${dash(f.n_app)} | 상태: ${dash(f.status)} | 대리인: ${dash(f.attorney_out)}`));
  } else L.push('  (연계된 해외출원 없음)');
  L.push('');
  if (files.length) {
    L.push('[전자포대 다운로드 파일 목록]');
    files.forEach((f, i) => L.push(`  ${i + 1}. ${f.name} (${f.size})`));
    L.push('');
  }
  const p = (n) => String(n).padStart(2, '0');
  L.push(bar, `생성일시: ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`, bar);
  return L.join('\n');
}

/** 표 칸 하나: 줄바꿈은 띄어쓰기로, | 는 글자로 */
const cell = (v) => oneLine(v).replace(/\|/g, '\\|');

/**
 * OPMS 창 "메모로" — 사건 정보를 메모 한 장(마크다운)으로: 제목 = 관리번호 + 명칭, 서지 표 · 업무배분 · 해외출원, #OPMS 태그
 */
export function caseMemoMarkdown(c, { mywork = [], foreign = [], summary = '', details = null } = {}) {
  const ref = String(c.ourref || c.yourref || c.n_app || '사건').trim();
  const title = [ref, String(c.title_kor ?? '').replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ');
  const L = [`# ${title}`, ''];
  if (summary) L.push(`해외출원: ${summary}`, '');
  L.push('| 항목 | 내용 |', '| --- | --- |');
  for (const [k, v] of [
    ['사무소관리번호', c.ourref], ['출원인관리번호', c.yourref], ['구분', c.div], ['출원인', c.applicant], ['발명자', c.inventor],
    ['수임일', cleanDate(c.d_accept)], ['출원번호', c.n_app], ['출원일', cleanDate(c.d_app)], ['등록번호', c.n_issue],
    ['등록일', cleanDate(c.d_issue)], ['발명명칭', c.title_kor], ['비고', c.memo],
  ]) if (String(v ?? '').trim() || k !== '비고') L.push(`| ${k} | ${cell(v)} |`);
  if (mywork.length) {
    L.push('', '## 업무배분', '', '| 업무 | 담당 | 접수 | 기한 | 완료 | 상세 |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of mywork) {
      const per = r.per_gubun ? `${dash(r.per_name)}(${r.per_gubun})` : r.per_name;
      L.push(`| ${cell(r.div_job)} | ${cell(per)} | ${cell(cleanDate(r.d_rec))} | ${cell(cleanDate(r.d_due))} | ${cell(cleanDate(r.d_end))} | ${cell(r.detail || r.memo)} |`);
    }
  }
  // 신규성 의제 (사건 표의 칸) · 찾은 표마다 (신규성 의제 · 진행사항 · 메모)
  if (details?.novelty?.length) {
    L.push('', '## 신규성 의제', '', '| 항목 | 내용 |', '| --- | --- |');
    for (const n of details.novelty) L.push(`| ${cell(n.label)} | ${cell(n.value)} |`);
  }
  for (const sec of details?.sections ?? []) {
    if (!sec.rows?.length) continue;
    if (sec.id === 'progress') {
      // 진행사항은 한 줄씩: "- 2026-07-13 **제출** 우선심사신청서 (기한 …) — 메모 · 접수번호 …"
      L.push('', `## ${sec.label}`, '');
      for (const it of progressItems(sec.rows)) {
        const extra = [it.memo, ...it.meta.map(([k, v]) => `${k} ${v}`)].filter(Boolean).join(' · ');
        L.push(`- ${it.date || '날짜 없음'} **${it.kind}** ${oneLine(it.title)}${it.due ? ` (기한 ${it.due})` : ''}${extra ? ` — ${oneLine(extra)}` : ''}`);
      }
      continue;
    }
    L.push('', `## ${sec.label}`, '', `| ${sec.columns.map((x) => cell(x.label)).join(' | ')} |`, `| ${sec.columns.map(() => '---').join(' | ')} |`);
    for (const r of sec.rows) L.push(`| ${sec.columns.map((x) => cell(r[x.key])).join(' | ')} |`);
  }
  if (foreign.length) {
    L.push('', '## 해외출원', '', '| 국가 | 구분 | 사무소관리번호 | 출원번호 | 상태 | 현지대리인 |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of foreign) L.push(`| ${cell(f.app_ncode || f._div)} | ${cell(f._div)} | ${cell(f.ourref)} | ${cell(f.n_app)} | ${cell(f.status)} | ${cell(f.attorney_out)} |`);
  }
  L.push('', '#OPMS', '');
  return L.join('\n');
}

// ---------- 더 보기: 신규성 의제 · 진행사항 · 메모 ----------
// 이 세 가지가 어느 표에 있는지는 회사 DB 마다 이름이 달라, 처음 한 번 OPMS 의 표·열 목록(INFORMATION_SCHEMA)을 받아
// 이름으로 고른다: 표 이름에 그 말이 들고, 사건 번호(idx)로 이어지는 열이 있는 표. 못 찾으면 그렇게 알리고, 표 목록을 복사할 수 있다.

export const DETAIL_KINDS = [
  { id: 'novelty', label: '신규성 의제', words: /novel|grace|except|nov(?![a-z])|ex30|30jo/i },
  { id: 'progress', label: '진행사항', words: /progress|prog(?![a-z])|hist|step|proc(?![a-z])|process|timeline|tracking/i },
  { id: 'memo', label: '메모', words: /memo|note|remark|comment/i },
];
// 사건(opms_app.idx)을 가리키는 열 이름 — 앞의 것일수록 먼저
export const LINK_COLUMNS = ['idx_app', 'app_idx', 'idx_parent', 'idx_relation', 'idx_case', 'case_idx', 'parent_idx', 'idx_master'];
// 이미 다른 탭에서 보이는 표 (다시 고르지 않음)
const KNOWN_TABLES = /^(opms_app|opms_attach|view_opms_mywork(_per)?|view_opms_dem_kor|opms_out(_pri)?|view_opms_out_family|view_opms_family_link)$/i;
const SAFE_NAME = /^[A-Za-z0-9_]+$/;

export const buildSchemaSql = () =>
  "SELECT TABLE_NAME, COLUMN_NAME\nFROM INFORMATION_SCHEMA.COLUMNS\nWHERE TABLE_NAME LIKE '%opms%'\nORDER BY TABLE_NAME, ORDINAL_POSITION";

/** INFORMATION_SCHEMA 줄 → Map(표 이름 → [열 이름]) */
export function groupSchema(rows) {
  const out = new Map();
  for (const r of rows) {
    const t = String(r.TABLE_NAME ?? r.table_name ?? '').trim();
    const c = String(r.COLUMN_NAME ?? r.column_name ?? '').trim();
    if (!SAFE_NAME.test(t) || !SAFE_NAME.test(c)) continue;
    if (!out.has(t)) out.set(t, []);
    out.get(t).push(c);
  }
  return out;
}

const linkOf = (cols) => LINK_COLUMNS.find((l) => cols.some((c) => c.toLowerCase() === l)) ?? null;
const realName = (cols, lower) => cols.find((c) => c.toLowerCase() === lower);

/**
 * 종류마다 가장 그럴듯한 표 하나: 이름에 그 말이 들고 사건으로 이어지는 열이 있는 표.
 *   보기(view_)보다 원래 표, "app" 이 든 이름, 짧은 이름을 앞에
 * @returns {Record<string, { table: string, link: string, columns: string[] } | null>}
 */
export function pickDetailTables(schema) {
  const out = {};
  for (const kind of DETAIL_KINDS) {
    const cands = [];
    for (const [table, cols] of schema) {
      if (KNOWN_TABLES.test(table) || !kind.words.test(table.replace(/^(view_)?opms_?/i, ''))) continue;
      const link = linkOf(cols);
      if (!link) continue;
      const score = (/^view_/i.test(table) ? 2 : 0) + (/app/i.test(table) ? 0 : 1) + table.length / 100 + LINK_COLUMNS.indexOf(link) / 10;
      cands.push({ table, link: realName(cols, link), columns: cols, score });
    }
    cands.sort((a, b) => a.score - b.score);
    out[kind.id] = cands[0] ? { table: cands[0].table, link: cands[0].link, columns: cands[0].columns } : null;
  }
  return out;
}

/** 사건 표(opms_app)에 바로 든 신규성 의제 칸 (예: ck_novelty, d_novelty) */
export const noveltyColumnsOf = (schema) => {
  const cols = [...schema].find(([t]) => t.toLowerCase() === 'opms_app')?.[1] ?? [];
  return cols.filter((c) => DETAIL_KINDS[0].words.test(c));
};

export function buildDetailSql({ table, link, columns }, caseIdx) {
  if (!SAFE_NAME.test(table) || !SAFE_NAME.test(link)) throw new Error('표 이름이 이상해요');
  const has = (c) => columns.some((x) => x.toLowerCase() === c);
  const where = [`[${link}] = '${sqlQuote(caseIdx)}'`];
  if (has('del_flag')) where.push(`[${realName(columns, 'del_flag')}] = 'N'`);
  if (has('ck_del')) where.push(`[${realName(columns, 'ck_del')}] = 'N'`);
  const order = has('idx') ? ` ORDER BY [${realName(columns, 'idx')}] ASC` : '';
  return `SELECT TOP 200 * FROM [${table}] WHERE ${where.join(' AND ')}${order}`;
}

// 화면에 보일 열 이름 (모르는 열은 이름 그대로)
const COLUMN_LABELS = {
  memo: '메모', content: '내용', contents: '내용', detail: '상세', note: '메모', remark: '비고', comment: '메모', title: '제목', subject: '제목',
  status: '상태', state: '상태', step: '단계', div: '구분', div_sub: '세부', kind: '구분', type: '구분', gubun: '구분',
  per_name: '담당', writer: '쓴 사람', reg_name: '쓴 사람', reg_user: '쓴 사람', user_name: '쓴 사람', name: '이름',
  d_reg: '등록일', reg_date: '등록일', d_date: '날짜', d_proc: '처리일', d_due: '기한', d_end: '완료', d_rec: '접수',
  d_pub: '공개일', d_disclose: '공개일', d_novelty: '의제일', n_doc: '문서번호', doc_name: '문서',
  no_rec: '접수번호', d_noti: '통지일', rec_doc: '받은 서류', rec_memo: '메모', d_pre: '제출일', pre_doc: '낸 서류', pre_div: '제출처', clerk: '담당', reg_per: '등록자', n_extend: '연장',
};
// 화면에 보이지 않을 열: 번호·삭제 표시·바꾼 사람/때 같은 내부 값
const HIDDEN_COLUMN = /^(idx|idx_.*|.*_idx|del_flag|ck_del|deleteflg|grp_key|upd_.*|mod_.*|reg_id|user_id|.*_id|rowid|seq|sort|part_code)$/i;

/** 표 줄 → { columns: [{ key, label }], rows: [{key: 값}] } — 비어 있는 열·내부 열은 빼고, 날짜는 YYYY-MM-DD */
export function detailRows(rows) {
  if (!rows.length) return { columns: [], rows: [] };
  const keys = Object.keys(rows[0]).filter((k) => !HIDDEN_COLUMN.test(k) && rows.some((r) => String(r[k] ?? '').trim()));
  const columns = keys.map((key) => ({ key, label: COLUMN_LABELS[key.toLowerCase()] ?? key }));
  return {
    columns,
    rows: rows.map((r) => Object.fromEntries(keys.map((k) => [k, /^\d{4}-\d{2}-\d{2}[ T]\d/.test(String(r[k] ?? '')) ? cleanDate(r[k]) : String(r[k] ?? '').replace(/[\r\n]+/g, ' ').trim()]))),
  };
}

// ---------- 서버와 주고받기 ----------

export class Opms {
  /** @param {{ host?: string, fetch?: typeof fetch, timeoutMs?: number, retries?: number }} o */
  constructor({ host = DEFAULT_HOST, fetch: f = globalThis.fetch, timeoutMs = 15000, retries = 2 } = {}) {
    Object.assign(this, { host: String(host).replace(/\/+$/, ''), fetch: f, timeoutMs, retries });
  }

  async request(url, init, { timeoutMs = this.timeoutMs, retries = this.retries } = {}) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (err) {
        last = err;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
    const e = new Error(`OPMS 서버(${this.host})에 접속하지 못했어요 — 사내망에 연결돼 있는지 확인해 주세요 (${last?.message ?? last})`);
    e.offline = true;
    throw e;
  }

  async select(sql, opts) {
    const body = new URLSearchParams({ connection: CONNECTION, count: '1', command: 'SELECT', sql });
    const res = await this.request(`${this.host}${JBORI_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'User-Agent': USER_AGENT },
      body: body.toString(),
    }, opts);
    return parseResultset(await res.text());
  }

  /** OPMS 의 표·열 목록 (한 번 받아 두고 다시 씀) */
  schema() {
    this.schemaPromise ??= this.select(buildSchemaSql()).then(groupSchema).catch((err) => {
      this.schemaPromise = null;
      throw err;
    });
    return this.schemaPromise;
  }

  /**
   * 신규성 의제 · 진행사항 · 메모 — 표를 찾은 것만 받아 온다
   * @returns {Promise<{ sections: { id, label, table, columns, rows, error? }[], novelty: { label, value }[], missing: string[] }>}
   */
  async details(c) {
    const schema = await this.schema();
    const picks = pickDetailTables(schema);
    const sections = await Promise.all(DETAIL_KINDS.map(async (kind) => {
      const pick = picks[kind.id];
      if (!pick) return { id: kind.id, label: kind.label, table: null, columns: [], rows: [] };
      try {
        return { id: kind.id, label: kind.label, table: pick.table, ...detailRows(await this.select(buildDetailSql(pick, c.idx))) };
      } catch (err) {
        return { id: kind.id, label: kind.label, table: pick.table, columns: [], rows: [], error: err.message };
      }
    }));
    // 사건 표에 바로 든 신규성 의제 칸
    const ncols = noveltyColumnsOf(schema);
    let novelty = [];
    if (ncols.length) {
      const [row] = await this.select(`SELECT ${ncols.map((x) => `[${x}]`).join(', ')} FROM opms_app WHERE idx = '${sqlQuote(c.idx)}'`).catch(() => []);
      novelty = ncols.map((k) => ({ label: COLUMN_LABELS[k.toLowerCase()] ?? k, value: cleanDate(row?.[k] ?? '') })).filter((x) => x.value);
    }
    return { sections, novelty, missing: sections.filter((x) => !x.table).map((x) => x.label) };
  }

  /** 문제 알리기용: OPMS 표 이름과 열 (못 찾았을 때 복사해 보낼 수 있게) */
  async schemaText() {
    const schema = await this.schema();
    return [...schema].map(([t, cols]) => `${t}: ${cols.join(', ')}`).join('\n');
  }

  find(query, opts) {
    return this.select(buildLookupSql(query), opts);
  }

  async caseByIdx(idx) {
    const [c] = await this.select(buildCaseByIdxSql(idx));
    return c ?? null;
  }

  mywork(idx) {
    return this.select(buildMyworkSql(idx));
  }

  bills(idx) {
    return this.select(buildBillSql(idx));
  }

  async attachments(idx) {
    return attachmentItems(await this.select(buildAttachSql(idx)));
  }

  /** 세 길 중 하나가 실패해도 나머지는 보여 준다 */
  async foreign(c) {
    const lists = await Promise.all(buildForeignSqls(c).map((sql) => this.select(sql).catch(() => [])));
    return mergeForeign(lists);
  }

  attachmentUrl(upload) {
    return `${this.host}${STATIC_PATH}/${String(upload ?? '').trim().replace(/^\/+/, '')}`;
  }

  /**
   * 전자포대 받기: baseDir/<관리번호 폴더>/<파일 이름>. 이미 있는 파일은 건너뛴다. all 이면 사건정보.txt 도.
   * @returns {Promise<{ dir: string, saved: number, skipped: number, failed: { name: string, error: string }[] }>}
   */
  async download(c, items, { baseDir, all = false, onProgress = () => {} } = {}) {
    const dir = path.join(baseDir, wrapperFolderName(c));
    await fs.promises.mkdir(dir, { recursive: true });
    let saved = 0;
    let skipped = 0;
    const failed = [];
    const done = [];
    for (const [i, it] of items.entries()) {
      const dest = path.join(dir, safeFilename(it.name, `attachment_${it.n}.bin`));
      if (path.dirname(dest) !== dir) continue; // 이름에 경로가 섞였으면 건너뛴다 (safeFilename 이 막지만 한 번 더)
      onProgress({ i, total: items.length, name: it.name });
      if (fs.existsSync(dest)) {
        skipped++;
        done.push(it);
        continue;
      }
      try {
        const res = await this.request(this.attachmentUrl(it.upload), { headers: { 'User-Agent': USER_AGENT } });
        await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        saved++;
        done.push(it);
      } catch (err) {
        failed.push({ name: it.name, error: err.message });
      }
    }
    if (all) {
      const [mywork, foreign] = await Promise.all([this.mywork(c.idx).catch(() => []), this.foreign(c).catch(() => [])]);
      await fs.promises.writeFile(path.join(dir, '사건정보.txt'), caseInfoText(c, { mywork, foreign, files: done }), 'utf8');
    }
    onProgress({ i: items.length, total: items.length, name: '' });
    return { dir, saved, skipped, failed };
  }
}
