// 메모 안 찾기 · 바꾸기 (워드의 찾기 및 바꾸기처럼) — 글자 줄에서 찾을 말의 자리 찾기 (순수 함수, 단위 테스트 대상)
//   편집기(find-replace.js)는 문단마다 글을 모아 이것으로 찾고, 찾은 자리를 표시 · 바꾼다.
import { TEXT_COLORS, HIGHLIGHT_COLORS } from './html-marks.js';
import { UI } from './ui-text.js';

// 낱말 글자: 글자 · 숫자 · 밑줄 (한글 포함)
const WORD = /[\p{L}\p{N}_]/u;

/**
 * 글에서 찾을 말의 자리들 [시작, 끝) — 겹치지 않게 앞에서부터
 * @param {string} text
 * @param {string} query
 * @param {{ caseSensitive?: boolean, wholeWord?: boolean }} [o]
 *   caseSensitive: 대소문자 구분 (기본은 구분 안 함) · wholeWord: 낱말 전체만 (앞뒤가 낱말 글자가 아닐 때)
 * @returns {[number, number][]}
 */
export function findInText(text, query, { caseSensitive = false, wholeWord = false } = {}) {
  const s = String(text ?? '');
  const q = String(query ?? '');
  if (!q || !s) return [];
  // 대소문자를 무시할 때: 소문자로 바꿔도 길이가 같을 때만 (자리가 어긋나지 않게 — 아니면 그대로 찾는다)
  let hay = s;
  let needle = q;
  if (!caseSensitive) {
    const ls = s.toLowerCase();
    const lq = q.toLowerCase();
    if (ls.length === s.length && lq.length === q.length) {
      hay = ls;
      needle = lq;
    }
  }
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i)) {
    const end = i + needle.length;
    if (!wholeWord || ((i === 0 || !WORD.test(s[i - 1])) && (end === s.length || !WORD.test(s[end])))) {
      out.push([i, end]);
      i = end;
    } else i += 1;
  }
  return out;
}

/**
 * 지금 자리(pos)에서 다음 · 이전으로 갈 찾은 곳의 번호 (끝에서는 처음으로 돌아간다)
 * @param {{ from: number }[]} matches 문서 순서대로
 * @param {number} pos 커서 자리
 * @param {1|-1} dir
 */
export function stepMatch(matches, pos, dir = 1) {
  if (!matches.length) return -1;
  if (dir > 0) {
    const i = matches.findIndex((m) => m.from >= pos);
    return i < 0 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].from < pos) return i;
  return matches.length - 1;
}

/** 찾은 개수 글: "3/12" · 없으면 "없음" · 아직 안 찾았으면 "" */
export function findCountText(current, total, query) {
  if (!query) return '';
  if (!total) return '없음';
  return `${current >= 0 ? current + 1 : 0}/${total}`;
}

// ---------- 서식 찾기 · 바꾸기 (엑셀 · 워드의 "서식") ----------
//   서식 { bold, italic, underline, strike, code, color, highlight, clear }
//     bold … code: true 면 그 서식이 있어야 (찾기) · 붙인다 (바꾸기)
//     color · highlight: null 은 상관없음 · 'any' 는 아무 색이든 (찾기만) · '#색' 은 그 색
//     clear: 바꿀 때 원래 서식을 모두 지우고 위의 서식만 (바꾸기만)

export const FORMAT_FLAGS = [
  { key: 'bold', label: '굵게', mark: 'strong' },
  { key: 'italic', label: '기울임', mark: 'emphasis' },
  { key: 'underline', label: '밑줄', mark: 'mk_underline' },
  { key: 'strike', label: '취소선', mark: 'strike_through' },
  { key: 'code', label: '코드', mark: 'inlineCode' },
];
export const FORMAT_COLORS = [
  { key: 'color', label: '글자 색', mark: 'mk_color', colors: TEXT_COLORS },
  { key: 'highlight', label: '형광펜', mark: 'mk_highlight', colors: HIGHLIGHT_COLORS },
];

/** 서식을 하나라도 골랐는지 */
export function hasFormat(f) {
  return Boolean(f && (FORMAT_FLAGS.some((k) => f[k.key]) || f.color || f.highlight || f.clear));
}

/** 고른 서식을 글로: "굵게, 빨강 글자 색" · 없으면 "" */
export function formatSummary(f) {
  if (!hasFormat(f)) return '';
  const parts = [];
  if (f.clear) parts.push(UI.clearFormat);
  for (const k of FORMAT_FLAGS) if (f[k.key]) parts.push(k.label);
  for (const k of FORMAT_COLORS) {
    const v = f[k.key];
    if (!v) continue;
    const name = k.colors.find((c) => c.value === v)?.name;
    parts.push(v === 'any' || !name ? k.label : `${name} ${k.label}`);
  }
  return parts.join(', ');
}

/** 글자 하나에 붙은 서식 [{ name, color }] 이 찾는 서식에 맞는지 */
export function marksMatch(marks, f) {
  if (!hasFormat(f)) return true;
  const has = (name) => marks.find((m) => m.name === name);
  for (const k of FORMAT_FLAGS) if (f[k.key] && !has(k.mark)) return false;
  for (const k of FORMAT_COLORS) {
    const v = f[k.key];
    if (!v) continue;
    const m = has(k.mark);
    if (!m || (v !== 'any' && String(m.color ?? '').toLowerCase() !== v.toLowerCase())) return false;
  }
  return true;
}

/**
 * 문단 글자 조각 segs [{ start, end, text, marks }] (text: 글자 조각인지 — 그림 같은 칸은 false) 에서
 *   찾은 자리 [a, b) 의 글자가 모두 서식에 맞는지
 */
export function rangeMatches(segs, a, b, f) {
  if (!hasFormat(f)) return true;
  for (const s of segs) {
    if (s.end <= a || s.start >= b) continue;
    if (!s.text || !marksMatch(s.marks, f)) return false;
  }
  return true;
}

/** 찾을 말 없이 서식만 찾을 때: 서식이 맞는 글자 조각을 이어 붙인 자리들 [시작, 끝) */
export function formatRuns(segs, f) {
  const out = [];
  if (!hasFormat(f)) return out;
  for (const s of segs) {
    const ok = s.text && s.end > s.start && marksMatch(s.marks, f);
    if (!ok) continue;
    const last = out[out.length - 1];
    if (last && last[1] === s.start) last[1] = s.end;
    else out.push([s.start, s.end]);
  }
  return out;
}

/** 모두 찾기 목록의 한 줄: 찾은 말 앞뒤를 조금씩 (긴 줄은 잘라서) */
export function snippet(text, a, b, radius = 18) {
  const s = String(text ?? '');
  const start = Math.max(0, a - radius);
  const end = Math.min(s.length, b + radius * 2);
  return { before: s.slice(start, a).replace(/\s+/g, ' '), hit: s.slice(a, b), after: s.slice(b, end).replace(/\s+/g, ' '), cutStart: start > 0, cutEnd: end < s.length };
}
