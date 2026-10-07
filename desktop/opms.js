// OPMS 조회 (회사 사건 관리 시스템) — 매직키의 "OPMS 검색" 모듈과 OPMS 창이 쓴다 (PC 전용)
//   opms_lookup_v2.py 를 옮긴 것. 사내망 서버의 /servlet/Jbori 에 SELECT 글을 보내고, 줄마다 \x01 로 나뉜 표를 받는다
//   (1줄 = 열 이름, 2~4줄 = 정보, 5줄부터 = 자료). 전자포대 원본은 <서버>/OPMS/<FILE_NAME_UPLOAD>
//   찾는 말은 모두 따옴표를 겹쳐(') SQL 글 안에 값으로만 넣는다.
import fs from 'node:fs';
import path from 'node:path';
export { looksLikeRef } from '../app/js/core/magic-modules.js';

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
  `WHERE DELETEFLG = 'N'\n  AND GRP_KEY = '${sqlQuote(groupKey)}'\n  AND ISNULL(DOC_NAME, '') <> 'HDR'\nORDER BY registered_at ASC, IDX ASC`;

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

/** 전자포대 줄 → 화면에 보일 모양 (원본 경로가 없는 줄은 뺀다) */
export function attachmentItems(rows) {
  return rows
    .filter((r) => String(r.FILE_NAME_UPLOAD ?? '').trim())
    .map((r, i) => ({
      n: i + 1,
      date: cleanDate(r.registered_at || r.REG_DATE),
      doc: String(r.DOC_NAME || r.DOC_GUBUN || '').trim(),
      name: safeFilename(String(r.FILE_NAME_ORI || r.FILE_NAME || '').trim(), `attachment_${i + 1}.bin`),
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
