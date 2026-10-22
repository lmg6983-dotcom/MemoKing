// OPMS 사건 찾기 — 무엇으로 찾는지 가르고(번호 · 이름 · 초성), 찾은 사건을 정확한 것부터 (순수 함수, 단위 테스트 대상)
//   번호: 관리번호 · 출원번호 · 등록번호의 일부만 써도 (0271 · 2026-0012 · 0012345), 기호는 빼고 비교
//   이름: 출원인 · 발명자 이름의 일부 (홍길 · 메모킹), 영문은 관리번호 글자도 (FPD)
//   초성: ㅎㄱㄷ → 홍길동 (OPMS 의 이름 목록에서 초성이 맞는 이름을 골라 그 이름으로 찾는다 — 서버는 초성을 모름)
import { isChoseongQuery, choseongRange, compactText } from './text-match.js';

const MAX_WORDS = 3;
const MAX_NAME = 20;

/**
 * 'ref' 번호 · 'name' 이름 · 'choseong' 초성 · null (회사 서버에 묻지 않을 글 — 문장 · 긴 글 · 한 글자)
 * @param {string} text
 */
export function opmsQueryKind(text) {
  const s = String(text ?? '').trim();
  if (!s || s.includes('\n') || s.length > 40) return null;
  const words = s.split(/\s+/);
  if (words.every((w) => isChoseongQuery(w)) && s.replace(/\s/g, '').length >= 2) return 'choseong';
  if (/\d/.test(s)) return s.replace(/[^0-9A-Za-z]/g, '').length >= 3 ? 'ref' : null;
  // 이름: 낱말 3개까지 · 20자까지 · 낱말마다 두 글자 이상 (메모로 쓰는 문장은 묻지 않게)
  if (words.length > MAX_WORDS || s.length > MAX_NAME || words.some((w) => w.length < 2)) return null;
  if (words.every((w) => /^[가-힣A-Za-z().&·-]+$/.test(w)) && (/[가-힣]{2,}/.test(s) || /[A-Za-z]{3,}/.test(s))) return 'name';
  return null;
}

/** 매직키가 OPMS 에 물어볼 글인가 */
export const looksLikeOpmsQuery = (text) => opmsQueryKind(text) !== null;

// 회사 · 사람 이름 칸 하나에 여럿: "홍길동, 김철수" · "메모킹 주식회사; (주)킹" · 줄바꿈
const NAME_SPLIT = /[,;/\n]|\s{2,}|\s+및\s+/;
const COMPANY_MARK = /\(\s*주\s*\)|㈜|주식회사|\(\s*유\s*\)|유한회사/g;

/** 이름 칸 → 이름들 (앞뒤 빈칸 · 빈 것 빼고) */
export function splitNames(value) {
  return String(value ?? '').split(NAME_SPLIT).map((n) => n.trim()).filter((n) => n.length >= 2);
}
// 비교용: 소문자 · 띄어쓰기 · (주) 빼고 — "메모킹 주식회사" 를 "메모킹" 으로도 같은 이름으로
const nameKey = (n) => compactText(String(n).replace(COMPANY_MARK, ''));

/**
 * 초성 검색어에 맞는 이름들 (OPMS 이름 목록에서) — 첫머리부터 맞고 짧은 이름이 앞
 * @param {string[]} names
 * @param {string} query ㅎㄱㄷ (띄어쓰기는 무시)
 */
export function matchChoseongNames(names, query, limit = 12) {
  const q = String(query ?? '').replace(/\s+/g, '');
  if (!isChoseongQuery(q)) return [];
  const seen = new Set();
  const hits = [];
  for (const n of names ?? []) {
    const name = String(n).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const bare = name.replace(COMPANY_MARK, '').trim();
    const r = choseongRange(bare, q);
    if (!r) continue;
    const letters = bare.replace(/\s+/g, '').length;
    hits.push({ name, rank: (r[0] === 0 ? 0 : 2) + (q.length === letters ? 0 : 1), len: letters });
  }
  hits.sort((a, b) => a.rank - b.rank || a.len - b.len || a.name.localeCompare(b.name, 'ko'));
  return hits.slice(0, limit).map((h) => h.name);
}

// 번호 칸: 사무소 관리번호 · 출원인 관리번호 · 출원번호 · 등록번호
const REF_FIELDS = [['ourref', 0], ['yourref', 4], ['n_app', 2], ['n_issue', 6]];

/** 번호가 얼마나 맞나: 같음 100 · 첫머리 80 · 끝자리 76 · 일부 60 (칸마다 조금씩 덜) */
function refScore(r, q) {
  const qc = compactText(q);
  if (qc.length < 3) return 0;
  let best = 0;
  for (const [field, minus] of REF_FIELDS) {
    const c = compactText(r[field]);
    if (!c) continue;
    const s = c === qc ? 100 : c.startsWith(qc) ? 80 : c.endsWith(qc) ? 76 : c.includes(qc) ? 60 : 0;
    if (s) best = Math.max(best, s - minus);
  }
  return best;
}

/** 이름이 얼마나 맞나 (출원인이 발명자보다 조금 앞): 같음 90 · 첫머리 72 · 일부 56 · 초성 같음 82 · 초성 첫머리 64 · 초성 일부 46 */
function nameScore(r, q, kind) {
  const terms = String(q).trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const t of terms) {
    let best = 0;
    for (const [field, minus] of [['applicant', 0], ['inventor', 4]]) {
      for (const name of splitNames(r[field])) {
        let s = 0;
        if (kind === 'choseong' || isChoseongQuery(t)) {
          const bare = name.replace(COMPANY_MARK, '').trim();
          const hit = choseongRange(bare, t);
          if (hit) s = hit[0] === 0 ? (t.length === bare.replace(/\s+/g, '').length ? 82 : 64) : 46;
        } else {
          const k = nameKey(name);
          const tk = nameKey(t);
          s = !tk ? 0 : k === tk ? 90 : k.startsWith(tk) ? 72 : k.includes(tk) ? 56 : 0;
        }
        if (s) best = Math.max(best, s - minus);
      }
    }
    if (!best && kind === 'name') best = refScore(r, t) * 0.7; // 영문 낱말이 관리번호에 맞은 것 (FPD)
    if (!best) return 0; // 낱말 하나라도 안 맞으면 (서버가 넓게 준 것)
    total += best;
  }
  return total / terms.length;
}

/**
 * 찾은 사건을 정확한 것부터 — 같은 점수면 최근 접수한 것부터. 맞지 않는 것(점수 0)은 뒤로
 * @param {object[]} rows OPMS 사건 줄
 * @param {string} query
 */
export function rankCases(rows, query) {
  const kind = opmsQueryKind(query) ?? 'ref';
  const scored = (rows ?? []).map((r, i) => ({ r, i, s: kind === 'ref' ? refScore(r, query) : nameScore(r, query, kind) }));
  scored.sort((a, b) => b.s - a.s || String(b.r.d_accept ?? '').localeCompare(String(a.r.d_accept ?? '')) || a.i - b.i);
  return scored.map(({ r, s }) => Object.assign(r, { _score: Math.round(s) }));
}

/** 사건 줄에 보여 줄 발명자 (이름으로 찾았고 발명자 칸에서 맞았을 때만 — 늘 쓰면 줄이 길어진다) */
export function matchedInventor(r, query) {
  const kind = opmsQueryKind(query);
  if (kind !== 'name' && kind !== 'choseong') return '';
  const hit = splitNames(r.inventor).find((n) => nameScore({ applicant: '', inventor: n }, query, kind) > 0);
  return hit ?? '';
}

/**
 * 사건번호를 온전히 쓴 글인가 — 이것만 매직키가 고르기 전에 저절로 OPMS 에 묻는다 (일부 번호 · 이름 · 초성은 고를 때만)
 *   출원번호 전체: 10-2026-0012345 · 1020260012345 · 2026-0012345
 *   관리번호 꼴: 영문과 숫자가 기호로 이어진 것 (FPD/2026-0271/E · P2026-1170-KR01 · P-12345) 또는 영문으로 시작해 숫자가 4개 넘는 것 (P20261170KR01)
 *   전화번호(010-1234-5678) · 날짜(2026-10-22) · 숫자만 · 띄어 쓴 글은 아님
 */
export function isExactCaseRef(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 30 || /\s/.test(s)) return false;
  if (/^\d{2}-\d{4}-\d{7}$/.test(s) || /^\d{13}$/.test(s) || /^\d{4}-\d{7}$/.test(s)) return true;
  if (!/[A-Za-z]/.test(s) || (s.match(/\d/g) ?? []).length < 4) return false;
  return /^[A-Za-z0-9]+(?:[-/._][A-Za-z0-9]+)+$/.test(s) || /^[A-Za-z]{1,5}\d{4,}[A-Za-z0-9]*$/.test(s);
}
