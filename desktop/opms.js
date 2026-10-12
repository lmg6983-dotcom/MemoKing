// OPMS 조회 (회사 사건 관리 시스템) — 매직키의 "OPMS 검색" 모듈과 OPMS 창이 쓴다 (PC 전용)
//   opms_lookup_v2.py 를 옮긴 것. 사내망 서버의 /servlet/Jbori 에 SELECT 글을 보내고, 줄마다 \x01 로 나뉜 표를 받는다
//   (1줄 = 열 이름, 2~4줄 = 정보, 5줄부터 = 자료). 전자포대 원본은 <서버>/OPMS/<FILE_NAME_UPLOAD>
//   찾는 말은 모두 따옴표를 겹쳐(') SQL 글 안에 값으로만 넣는다.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export { looksLikeRef } from '../app/js/core/magic-modules.js';
import { progressItems } from '../app/js/core/opms-progress.js';
import { decodeEntities } from '../app/js/core/entities.js';

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

// "열기" 로 바로 여는 것은 서류 · 그림 · 압축 파일만. 그 밖의 것(실행 파일 · 바로 가기 · 스크립트 · 모르는 형식)은
//   실수로 실행되지 않게 열지 않고 폴더에서 그 파일을 보여 준다
const OPENABLE_EXT = new Set(['pdf', 'hwp', 'hwpx', 'hwt', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'txt',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'zip', '7z', 'eml', 'msg', 'gul', 'mp3', 'mp4', 'wav', 'm4a']);
export function isOpenableFile(name) {
  const m = /\.([^.\\/]+)$/.exec(String(name ?? '').trim().replace(/[.\s]+$/, ''));
  return Boolean(m && OPENABLE_EXT.has(m[1].toLowerCase()));
}

export function fileSizeLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '-';
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

/** "의견서.pdf" + 2 → "의견서 (2).pdf" */
export function numberedName(name, k) {
  // 확장자는 끝의 ".영숫자" 만 ("Mr. Kim 의견서" · "v1.2 final" 처럼 이름 속 점은 확장자가 아님)
  const m = /^(.*?)(\.[A-Za-z0-9]{1,10})?$/.exec(name);
  return `${m[1]} (${k})${m[2] ?? ''}`;
}

// 전자포대 줄의 요약 · 등록자 (회사 DB 열 이름이 정해져 있지 않아 흔한 이름 중 먼저 있는 것)
//   요약은 서류 요약 전용 열만 (MEMO · CONTENTS 처럼 본문이 통째로 든 열은 쓰지 않음), 등록자는 사람 이름 열만 (로그인 ID 열은 쓰지 않음)
const SUMMARY_COLUMNS = ['SUMMARY', 'DOC_SUMMARY', 'SUMM', 'DOC_SUMM', 'ABSTRACT', 'DOC_MEMO'];
const WRITER_COLUMNS = ['REG_NAME', 'REG_USER_NAME', 'REG_PER_NAME', 'USR_NAME', 'USER_NAME', 'WRITER', 'WRITER_NAME'];
const SUMMARY_MAX = 120;
const pickColumn = (r, names, max = 40) => {
  const keys = new Map(Object.keys(r).map((k) => [k.toUpperCase(), k]));
  for (const n of names) {
    if (!keys.has(n)) continue;
    const v = decodeEntities(String(r[keys.get(n)] ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (v && v !== '-') return v.length > max ? `${v.slice(0, max - 1)}…` : v;
  }
  return '';
};

/**
 * 전자포대 줄 → 화면에 보일 모양 (원본 경로가 없는 줄은 뺀다). 줄은 최신순, No. 는 오래된 것부터 1 (새 서류가 와도 번호가 그대로)
 *   같은 파일 이름이 여럿이면(같은 서식의 통지서 등) 오래된 것은 그대로, 다음 것부터 "이름 (2).pdf" — 저장할 때 덮어쓰거나 건너뛰지 않게
 */
export function attachmentItems(rows) {
  const kept = rows.filter((r) => String(r.FILE_NAME_UPLOAD ?? '').trim());
  const items = kept.map((r, i) => ({
    n: kept.length - i,
    date: cleanDate(r.registered_at || r.REG_DATE),
    doc: String(r.DOC_NAME || r.DOC_GUBUN || '').trim(),
    name: safeFilename(String(r.FILE_NAME_ORI || r.FILE_NAME || '').trim(), `attachment_${kept.length - i}.bin`),
    size: fileSizeLabel(r.FILE_SIZE),
    summary: pickColumn(r, SUMMARY_COLUMNS, SUMMARY_MAX),
    writer: pickColumn(r, WRITER_COLUMNS),
    upload: String(r.FILE_NAME_UPLOAD).trim(),
  }));
  // 이름 겹침: 오래된 것(No. 작은 것)부터 차례로 (대소문자 무시 — Windows 파일 이름처럼)
  const used = new Set();
  for (const it of [...items].sort((x, y) => x.n - y.n)) {
    let name = it.name;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = numberedName(it.name, k);
    used.add(name.toLowerCase());
    it.name = name;
  }
  return items;
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

// 받은 전자포대 파일 기록: 사건 폴더 → { 서류(upload) → 저장한 파일 이름 }
//   이름만 같다고 같은 서류로 치지 않으려고. 사건 폴더가 아니라 앱 폴더에 한 파일로 둔다 (공유하는 폴더에 섞이지 않게).
//   한 번 받은 서류는 그 뒤 크기가 바뀌어도(사용자가 고쳐 저장) 그대로 둔다.
const LEGACY_MANIFEST = '.memoking.json'; // 0.31.2 가 사건 폴더에 남긴 기록 — 읽어 온다 (지우지 않음: 다른 PC 도 읽게)
class FileIndex {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.loading = null; // 처음 읽기는 한 번만 (동시에 불러도 같은 기록을 함께 쓰게)
    this.folders = new Map(); // 폴더 → 기록을 준비하는 일 (예전 기록 옮기기가 끝나기 전에 빈 기록을 보지 않게)
    this.locks = new Map(); // 폴더 → 마지막 저장 일 (한 폴더 안의 저장은 차례로 — 같은 이름에 두 서류가 동시에 들어가지 않게)
    this.seq = 0; // 기록마다 하나씩 커지는 번호 — 끌 때 쓴 기록(quit)과 평소 기록 중 새것을 고르려고
    this.dirty = false;
    this.flushing = null;
  }

  get quitFile() {
    return `${this.file}.quit`;
  }

  load() {
    this.loading ??= (async () => {
      let raw = null;
      if (this.file) {
        // 백신 · 동기화 프로그램이 잠깐 잡고 있으면(EBUSY 등) 조금 뒤 다시. 끝내 못 읽으면 이번 실행 동안은
        //   기록을 덮어쓰지 않는다 (빈 기록으로 바꿔 다른 사건 기록까지 잃지 않게)
        for (let i = 0; i < 4; i++) {
          try {
            raw = await fs.promises.readFile(this.file, 'utf8');
            break;
          } catch (err) {
            if (err.code === 'ENOENT') break;
            if (i === 3) this.readOnly = true;
            else await new Promise((r) => setTimeout(r, 250 * (i + 1)));
          }
        }
      }
      const asObject = (d) => (d && typeof d === 'object' && !Array.isArray(d) ? d : {});
      try {
        this.data = asObject(raw == null ? {} : JSON.parse(raw));
      } catch {
        // 깨진 기록은 지우지 않고 옆에 남겨 둔다 (새 기록으로 덮어 다른 사건 기록까지 잃지 않게)
        await fs.promises.rename(this.file, `${this.file}.broken-${Date.now()}`).catch(() => {});
        this.data = {};
      }
      // 끌 때 남긴 기록이 더 새것이면 그것으로 (그때 쓰던 평소 기록이 뒤늦게 옛 내용으로 끝났을 수 있어서)
      if (this.file) {
        try {
          const quit = asObject(JSON.parse(await fs.promises.readFile(this.quitFile, 'utf8')));
          if ((Number(quit['#seq']) || 0) > (Number(this.data['#seq']) || 0)) this.data = quit;
        } catch {
          // 없음 · 깨짐 — 평소 기록으로
        }
      }
      this.seq = Number(this.data['#seq']) || 0;
      return this.data;
    })();
    return this.loading;
  }

  /** 기록 칸: 서버마다 · 폴더마다 (서버를 바꾸면 같은 upload 라도 다른 서류) */
  static key(dir, host = '') {
    return `${String(host).toLowerCase()}|${path.resolve(dir).toLowerCase()}`;
  }

  /** 이 폴더의 기록 (0.31.2 의 폴더 안 기록이 있으면 가져온다) */
  folder(dir, host) {
    const k = FileIndex.key(dir, host);
    if (!this.folders.has(k)) this.folders.set(k, this.prepare(dir, k));
    return this.folders.get(k);
  }

  async prepare(dir, k) {
    sweepParts(dir);
    const data = await this.load();
    if (data[k]) return data[k];
    const rec = {};
    const legacyFile = path.join(dir, LEGACY_MANIFEST);
    let legacy = null;
    try {
      legacy = JSON.parse(await fs.promises.readFile(legacyFile, 'utf8'));
    } catch {
      // 없음
    }
    if (legacy && typeof legacy === 'object') {
      for (const [upload, v] of Object.entries(legacy)) {
        // 이 폴더 안의 파일 이름만. 0.31.2 는 다 받은 뒤에만 기록했으니 크기가 달라졌으면 사용자가 고친 것 — 그대로 인정
        //   (0.31.2 는 기본 서버만 썼으니 지금 서버의 기록으로 옮긴다)
        const name = String(v?.name ?? '');
        if (name && safeFilename(name, '') === name && path.basename(name) === name) rec[upload] = name;
      }
    }
    data[k] = rec;
    // 예전 기록은 지우지 않는다: 사건 폴더가 여러 PC 가 함께 쓰는 Drive 폴더면 다른 PC 도 읽어 가야 하니까
    if (legacy) this.save();
    return rec;
  }

  /** 한 폴더 안의 저장 일을 차례로 */
  exclusive(dir, job) {
    const k = path.resolve(dir).toLowerCase();
    const run = (this.locks.get(k) ?? Promise.resolve()).then(job, job);
    const settled = run.catch(() => {});
    this.locks.set(k, settled);
    settled.then(() => { if (this.locks.get(k) === settled) this.locks.delete(k); });
    return run;
  }

  /**
   * 기록 남기기 → 잘 남겼으면 true. 바로 쓴다 — 쓰는 중에 들어온 것은 모아서 한 번 더 (전체 받기 중에도 쓰기가 쌓이지 않게).
   *   실패해도(읽기 전용 · 백신이 잡고 있음) 받은 파일은 그대로 쓴다
   */
  save() {
    if (!this.file || this.readOnly) return Promise.resolve(false);
    this.dirty = true;
    this.flushing ??= (async () => {
      let ok = false;
      try {
        while (this.dirty) {
          this.dirty = false;
          ok = await this.writeOnce();
        }
      } finally {
        this.flushing = null;
      }
      return ok;
    })();
    return this.flushing;
  }

  async writeOnce() {
    const seq = ++this.seq;
    this.data['#seq'] = seq;
    const json = JSON.stringify(this.data);
    const tmp = `${this.file}.${process.pid}-${seq}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, json, 'utf8');
      await fs.promises.rename(tmp, this.file);
      return true;
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      return false;
    }
  }

  /**
   * 앱을 끌 때 — 기다릴 수 없으니 동기로, 쓰는 중인 평소 기록과 겹치지 않게 따로 둔 파일(.quit)에 더 큰 번호로.
   *   다음에 켤 때 둘 중 번호가 큰 것을 읽는다. 끄기가 취소돼도 그 뒤의 평소 기록은 번호가 더 커서 그대로 이어진다
   */
  flushSync() {
    if (!this.file || this.readOnly || !this.data || (!this.dirty && !this.flushing)) return;
    this.dirty = false;
    const seq = ++this.seq;
    this.data['#seq'] = seq;
    const tmp = `${this.quitFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.quitFile);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 다음 실행 때 내용을 비교해 다시 맞춘다
      }
    }
  }
}
/** 앱을 끌 때: 아직 쓰지 않은 전자포대 기록을 모두 남긴다 */
export function flushOpmsFiles() {
  for (const index of fileIndexes.values()) index.flushSync();
}
const fileIndexes = new Map(); // 기록 파일 → FileIndex (창마다 새 Opms 를 만들어도 같은 기록 · 같은 "받는 중" 을 함께 쓰게)
const savingFiles = new Map(); // 저장할 경로 → 받는 중인 일 (열기 · 전체 받기가 같은 파일을 동시에 받지 않게)
const sameBytes = async (file, data) => {
  try {
    const st = await fs.promises.stat(file);
    return st.size === data.length && (await fs.promises.readFile(file)).equals(data);
  } catch {
    return false;
  }
};
const exists = (file) => fs.promises.stat(file).then(() => true, () => false);
// 파일 받기: 전체 시간이 아니라 "멈춘 시간" 으로 끊는다 (큰 파일이 느리게라도 오면 끝까지 · 아예 멈추면 1분 뒤)
const DOWNLOAD_IDLE_MS = 60_000;
// 매크로가 들 수 있는 Office 형식은 Windows 의 "인터넷에서 받은 파일" 표시(Zone.Identifier)를 붙여
//   Office 가 제한된 보기 · 인터넷 매크로 차단을 그대로 하게 한다 (브라우저로 받은 것과 같게)
const MACRO_EXT = new Set(['doc', 'dot', 'xls', 'xlt', 'ppt', 'pot', 'pps', 'rtf',
  'docm', 'dotm', 'xlsm', 'xltm', 'xlsb', 'xlam', 'pptm', 'potm', 'ppsm', 'ppam', 'sldm']);
// 새 파일을 "그 이름이 비어 있을 때만" 제자리에: 같은 폴더의 임시 파일에 다 쓴 뒤 하드 링크(있으면 실패 · 한 번에 나타남).
//   하드 링크를 못 만드는 곳(USB · Drive 스트리밍 등)에서는 바로 앞에서 비어 있는지 다시 보고 이름 바꾸기.
//   임시 파일 이름은 짧게(긴 서류 이름도 255자를 넘지 않게) · "~$" 로 시작 (Office 임시 파일처럼 동기화 프로그램이 건너뜀)
const PART_PREFIX = '~$mk-';
async function placeNew(file, data) {
  // 임의 이름이라 겹치지 않는다 — 그래서 아래의 EEXIST 는 늘 제 이름이 이미 있다는 뜻
  const part = path.join(path.dirname(file), `${PART_PREFIX}${randomBytes(6).toString('hex')}.part`);
  try {
    await fs.promises.writeFile(part, data);
    try {
      await fs.promises.link(part, file);
    } catch (err) {
      if (err.code === 'EEXIST') throw err;
      if (await exists(file)) throw Object.assign(new Error(`${path.basename(file)} 이(가) 이미 있어요`), { code: 'EEXIST' });
      await fs.promises.rename(part, file);
    }
  } finally {
    await fs.promises.rm(part, { force: true }).catch(() => fs.promises.rm(part, { force: true }).catch(() => {}));
  }
}

// 끊긴 저장이 남긴 임시 파일 정리 (10분 넘은 것만 — 다른 PC 가 지금 쓰는 중일 수 있으니)
async function sweepParts(dir) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  const old = Date.now() - 10 * 60_000;
  for (const name of names) {
    if (!name.startsWith(PART_PREFIX) || !name.endsWith('.part')) continue;
    const file = path.join(dir, name);
    const st = await fs.promises.stat(file).catch(() => null);
    if (st && st.mtimeMs < old) await fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

async function markFromServer(file, host) {
  if (process.platform !== 'win32') return;
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!MACRO_EXT.has(ext)) return;
  await fs.promises.writeFile(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${host}\r\n`).catch(() => {});
}

export class Opms {
  /** @param {{ host?: string, fetch?: typeof fetch, timeoutMs?: number, retries?: number }} o */
  /** filesIndex: 받은 전자포대 파일 기록을 둘 JSON 경로 (없으면 이 프로그램이 켜져 있는 동안만 기억) */
  constructor({ host = DEFAULT_HOST, fetch: f = globalThis.fetch, timeoutMs = 15000, retries = 2, filesIndex = null, downloadIdleMs = DOWNLOAD_IDLE_MS } = {}) {
    Object.assign(this, { host: String(host).replace(/\/+$/, ''), fetch: f, timeoutMs, retries, downloadIdleMs });
    if (!fileIndexes.has(filesIndex)) fileIndexes.set(filesIndex, new FileIndex(filesIndex));
    this.files = fileIndexes.get(filesIndex);
  }

  /**
   * bytes: 응답 본문까지 받아 { res, data } — 이때 timeoutMs 는 "아무것도 오지 않은 시간" (조금씩이라도 오면 계속).
   *   본문 받기도 다시 하기 안에서
   */
  async request(url, init, { timeoutMs = this.timeoutMs, retries = this.retries, bytes = false } = {}) {
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (bytes) return await this.fetchBytes(url, init, timeoutMs);
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

  async fetchBytes(url, init, idleMs) {
    const ctl = new AbortController();
    let timer;
    let stalled;
    const stall = new Promise((_, reject) => { stalled = reject; });
    stall.catch(() => {});
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error('서버 응답이 멈췄어요');
        ctl.abort(err);
        stalled(err);
      }, idleMs);
    };
    arm();
    try {
      const res = await Promise.race([this.fetch(url, { ...init, signal: ctl.signal }), stall]);
      if (!res.ok) {
        res.body?.cancel().catch(() => {}); // 오류 본문은 읽지 않고 연결을 놓는다
        throw new Error(`HTTP ${res.status}`);
      }
      const chunks = [];
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          arm();
          const { done, value } = await Promise.race([reader.read(), stall]);
          if (done) break;
          chunks.push(Buffer.from(value));
        }
      }
      return { res, data: Buffer.concat(chunks) };
    } catch (err) {
      ctl.abort(err); // 멈춤 · 오류로 그만둘 때 연결도 끊는다
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
   * 전자포대 파일 하나를 dir 에 저장 → { file, reused }.
   *   - 전에 받은 그 서류(기록에 있음)면 다시 받지 않는다 — 사용자가 고쳐 저장했어도 그대로
   *   - 기록에 없는 같은 이름 파일(예전 방식으로 받은 것 · 사용자가 둔 것 · 다른 PC 가 받은 것)은 덮어쓰지 않는다:
   *     받아 보고 내용이 같은 파일이 있으면 그것을 쓰고, 없으면 "이름 (No.3).pdf" 처럼 빈 이름에 저장
   *   - 같은 폴더의 임시 파일(~$mk-….part)에 다 쓴 뒤 그 이름이 비어 있을 때만 제 이름으로 (반쯤 쓰인 파일이 제 이름으로 보이지 않게)
   *   - 같은 파일을 동시에(전체 받기 중에 열기) 부르면 한 번만 받는다. 이름 고르기 · 저장 · 기록만 폴더마다 차례로
   *     (받는 동안 같은 사건의 이미 받은 파일 열기를 막지 않게)
   */
  saveOne(dir, it) {
    const dest = path.join(dir, safeFilename(it.name, `attachment_${it.n}.bin`));
    if (path.dirname(dest) !== dir) return Promise.resolve(null); // 이름에 경로가 섞였으면 건너뛴다 (safeFilename 이 막지만 한 번 더)
    const key = `${FileIndex.key(dir, this.host)}\n${String(it.upload ?? '').trim()}`;
    if (!savingFiles.has(key)) savingFiles.set(key, this.saveFresh(dir, dest, it).finally(() => savingFiles.delete(key)));
    return savingFiles.get(key);
  }

  async saveFresh(dir, dest, it) {
    const upload = String(it.upload ?? '').trim();
    const folder = await this.files.folder(dir, this.host);
    const knownFile = async () => {
      const name = folder[upload];
      const file = name ? path.join(dir, name) : null;
      return file && path.dirname(file) === dir && await exists(file) ? file : null;
    };
    const had = await knownFile();
    if (had) return { file: had, reused: true };
    const { res, data } = await this.request(this.attachmentUrl(upload), { headers: { 'User-Agent': USER_AGENT } }, { timeoutMs: this.downloadIdleMs, retries: Math.min(1, this.retries), bytes: true });
    // 받다 끊김: 압축하지 않은 응답이면 Content-Length 와 받은 크기가 같아야 한다 (압축 응답은 풀린 크기라 비교하지 않음)
    const expected = Number(res.headers?.get?.('content-length'));
    const encoded = String(res.headers?.get?.('content-encoding') ?? 'identity').toLowerCase();
    if (encoded === 'identity' && Number.isFinite(expected) && expected > 0 && expected !== data.length) throw new Error('받는 중에 끊겼어요. 다시 해 주세요');
    return this.files.exclusive(dir, async () => {
      const now = await knownFile();
      if (now) return { file: now, reused: true };
      const claimed = new Set(Object.entries(folder).filter(([u]) => u !== upload).map(([, n]) => n.toLowerCase()));
      const base = path.basename(dest);
      // 이름 후보: 원래 이름 → (No.n) → (No.n-2) … 내용이 같은 파일이 있으면 그것, 아니면 첫 빈 이름.
      //   고른 이름이 그사이 생겼으면(다른 PC 의 파일이 동기화로 들어옴) 다음 후보로
      let file = null;
      let raced = 0;
      for (let k = 0; !file; k++) {
        const cand = path.join(dir, k === 0 ? base : numberedName(base, k === 1 ? `No.${it.n}` : `No.${it.n}-${k}`));
        if (claimed.has(path.basename(cand).toLowerCase())) continue;
        if (!await exists(cand)) {
          try {
            await placeNew(cand, data);
            file = cand;
          } catch (err) {
            if (err.code !== 'EEXIST' || ++raced > 5) throw err;
            k--; // 그사이 생긴 그 파일을 다시 본다 (같은 서류면 그것을 쓰게)
          }
        } else if (await sameBytes(cand, data)) {
          folder[upload] = path.basename(cand); // 예전에(다른 PC 에서) 받아 둔 바로 그 서류
          this.files.save();
          return { file: cand, reused: true };
        }
      }
      await markFromServer(file, this.host);
      folder[upload] = path.basename(file);
      this.files.save();
      return { file, reused: false };
    });
  }

  /** 전자포대 파일 하나를 사건 폴더에 저장(이미 있으면 그대로)하고 그 경로 — "열기" 단추 */
  async fileFor(c, it, baseDir) {
    const dir = path.join(baseDir, wrapperFolderName(c));
    await fs.promises.mkdir(dir, { recursive: true });
    return (await this.saveOne(dir, it))?.file ?? null;
  }

  /**
   * 전자포대 받기: baseDir/<관리번호 폴더>/<파일 이름>. 전에 받은 그 서류가 있으면 건너뛴다. all 이면 사건정보.txt 도.
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
      onProgress({ i, total: items.length, name: it.name });
      try {
        const r = await this.saveOne(dir, it);
        if (!r) continue;
        if (r.reused) skipped++;
        else saved++;
        done.push({ ...it, name: path.basename(r.file) }); // 실제로 저장된 이름 (다른 이름으로 피해 저장했을 수도)
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
