// 메모 파일(.md) 형식 — 머리말(YAML frontmatter) + 마크다운 본문.
// Node(데스크탑 메인)와 브라우저(화면, 추후 안드로이드) 양쪽에서 쓰는 순수 함수만 둔다.
import { parse as parseYaml, stringify as stringifyYaml } from '../../vendor/yaml.js';
import { tableLineText } from './tables.js';
import { toLocalIso, hhmm, koMonthDay } from './time.js';
import { normalizeReminder, serializeReminder } from './reminders.js';
import { normalizeTables } from './table-sizes.js';

export const COLORS = ['yellow', 'green', 'pink', 'purple', 'blue', 'gray', 'charcoal'];
export const COLOR_NAMES = { yellow: '노랑', green: '초록', pink: '분홍', purple: '보라', blue: '파랑', gray: '회색', charcoal: '검정' };
export const DEFAULT_COLOR = 'yellow';
export const UNTITLED = '제목 없음';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KNOWN_KEYS = ['id', 'created', 'updated', 'color', 'pinned', 'links', 'reminders', 'tables', 'ink', 'device'];
// 마지막으로 내용을 고친 곳 (이어 쓰기 안내: "휴대폰에서 방금 고친 메모")
export const DEVICES = ['pc', 'phone', 'ai'];
const AUDIO_EXT = /\.(weba|ogg|oga|opus|mp3|m4a|aac|wav|flac)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|ogv|mkv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

// ---------- 읽기 / 쓰기 ----------

// 머리말이 깨져 있으면 파일 전체를 본문으로 취급한다 (사용자 내용을 잃지 않도록).
export function parseMemoFile(text) {
  const source = text.replace(/^﻿/, '');
  const match = FRONTMATTER.exec(source);
  let data = {};
  let body = source;
  if (match) {
    try {
      const parsed = parseYaml(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      body = source.slice(match[0].length);
    } catch {
      data = {};
    }
  }
  return { meta: normalizeMeta(data), body };
}

export function normalizeMeta(data) {
  const extra = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_KEYS.includes(key)) extra[key] = value;
  }
  return {
    id: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null,
    created: asIsoString(data.created),
    updated: asIsoString(data.updated),
    color: COLORS.includes(data.color) ? data.color : DEFAULT_COLOR,
    pinned: data.pinned === true,
    links: Array.isArray(data.links) ? [...new Set(data.links.filter((v) => typeof v === 'string' && v))] : [],
    reminders: Array.isArray(data.reminders) ? data.reminders.map((r) => normalizeReminder(r)).filter(Boolean) : [],
    tables: normalizeTables(data.tables), // 표 열 너비·행 높이·머리글 강조 (표 순서대로)
    ink: normalizeInkPath(data.ink), // 주석(메모 위에 그린 손 메모)이 든 파일
    device: DEVICES.includes(data.device) ? data.device : null,
    extra,
  };
}

// 주석 파일은 메모 폴더의 attachments/ 안의 것만 (../ 로 밖을 가리키지 않게)
export function normalizeInkPath(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return /^attachments\/[^/\\]+$/.test(v) && !v.includes('..') ? v : '';
}

function asIsoString(value) {
  if (typeof value === 'string' && value) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return toLocalIso(value);
  return null;
}

// 앱이 모르는 머리말 항목(extra)도 그대로 다시 쓴다.
export function serializeMemoFile(meta, body) {
  const data = { id: meta.id, created: meta.created, updated: meta.updated, color: meta.color };
  if (meta.pinned) data.pinned = true;
  if (meta.links?.length) data.links = meta.links;
  if (meta.reminders?.length) data.reminders = meta.reminders.map(serializeReminder);
  const tables = normalizeTables(meta.tables);
  if (tables.length) data.tables = tables;
  if (normalizeInkPath(meta.ink)) data.ink = normalizeInkPath(meta.ink);
  if (DEVICES.includes(meta.device)) data.device = meta.device;
  Object.assign(data, meta.extra);
  const yaml = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
  const text = body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return `---\n${yaml}\n---\n${text}\n`;
}

// 편집기는 목록·그림으로 끝나는 메모 뒤에 빈 줄을 하나 붙여 두는데(이어 쓰기용),
// 빈 줄은 마크다운에서 "<br />" 로 저장되므로 문서 끝에 붙은 것만 떼어 낸다. 중간의 빈 줄은 사용자가 넣은 것이라 둔다.
export function trimTrailingBreaks(markdown) {
  return markdown.replace(/(?:\s*<br\s*\/?>)+\s*$/i, '\n');
}

// 2026-09-29T17:30:12+09:00 (사람이 읽기 쉬운 현지 시각 + 시간대)
export { toLocalIso };

// ---------- 본문 분석 ----------

/** 마크다운 자동 링크 <https://…> · <mailto:…> · <이름@주소> */
export const AUTOLINK = /<((?:https?|ftp|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/gi;

// 한 줄의 마크다운 기호를 걷어내 사람이 읽는 글자만 남긴다.
function stripInline(line) {
  return line
    // 줄 끝 \ 는 마크다운 줄바꿈(Shift+Enter) 기호 — 글자가 아니다 (\\ 로 쓴 진짜 역슬래시는 남김)
    .replace(/(^|[^\\])((?:\\\\)*)\\\s*$/, '$1$2')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(AUTOLINK, '$1') // 맨주소·이메일은 <https://…> 로 저장된다 — 태그로 보고 지우지 않게 주소를 남긴다
    .replace(/<\/?[a-z][^>]*>/gi, '') // <u>, <mark>, <span style=…> 같은 서식 태그는 글자만 남긴다
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\\*_])[*_](?=\S)(.+?)(?<=\S)[*_]/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBlock(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\\?\[[ xX]\](?:\s+|$))?/, ''); // 빈 체크리스트 항목("- [ ]")도
}

// 코드 블록 울타리(```)는 빼고, 각 줄을 읽는 글자로 바꾼다.
export function plainLines(body) {
  const lines = [];
  let fence = false;
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (!fence && /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue; // 구분선
    if (!fence && /^\s*<!--.*-->\s*$/.test(raw)) continue; // 한 줄 HTML 주석 (화면에 안 보임 — 잠금 메모의 암호문 등)
    // 표 줄은 "품목 · 가격" 처럼, 구분선(|---|) 은 뺀다
    const cells = fence ? null : tableLineText(raw);
    const text = fence ? raw.trim() : cells !== null ? stripInline(cells) : stripInline(stripBlock(raw));
    if (text) lines.push(text);
  }
  return lines;
}

export function plainText(body) {
  return plainLines(body).join('\n');
}

export function extractTitle(body) {
  const first = plainLines(body)[0];
  return first ? first.slice(0, 80) : UNTITLED;
}

// 제목(첫 줄)을 뺀 나머지로 만든 미리보기
//   카드에서 읽기 좋게: 공유하기로 붙은 "출처: …" 줄은 빼고, 수식 표시($)는 걷어낸다
export function extractPreview(body, maxLength = 160) {
  return plainLines(body)
    .slice(1)
    .filter((l) => !/^출처\s*[:：]/.test(l))
    .join(' ')
    .replace(/\${1,2}([^$]+?)\${1,2}/g, '$1')
    .slice(0, maxLength);
}

export function extractHeadings(body) {
  const headings = [];
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) headings.push(stripInline(m[1]));
  }
  return headings;
}

const isLocalPath = (src) => !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('#');

/**
 * 본문에 들어간 폴더 안 파일들 (인터넷 주소·data: 는 제외)
 *   ![설명](attachments/a.png)   → 이미지·소리·동영상 (embed)
 *   [파일명](attachments/b.pdf)  → 그 밖의 파일 (파일 칩)
 * @returns {{ src: string, alt: string, kind: 'image'|'audio'|'video'|'file' }[]}
 */
export function extractMedia(body) {
  const found = [];
  const seen = new Set();
  const re = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of body.matchAll(re)) {
    const embed = m[1] === '!';
    const src = safeDecode(m[3]);
    if (!isLocalPath(src) || seen.has(src)) continue;
    if (!embed && !src.startsWith('attachments/')) continue; // 다른 메모로 가는 링크 등은 첨부가 아님
    seen.add(src);
    found.push({ src, alt: m[2], kind: embed ? mediaKindOf(src, m[2]) ?? 'file' : 'file' });
  }
  return found;
}

export function extractAttachments(body) {
  return extractMedia(body).map((m) => m.src);
}

function safeDecode(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

const pathOnly = (src) => src.split(/[?#]/)[0];
export const isImage = (src) => IMAGE_EXT.test(pathOnly(src));

// 이미지·소리·동영상 구분. .webm 은 소리·영상 둘 다 될 수 있어 설명 글로 가른다
// ("동영상"/"video" 가 들어 있으면 영상, 아니면 소리 — 예전 녹음 메모는 소리로 재생).
export function mediaKindOf(src, alt = '') {
  const path = pathOnly(src);
  if (IMAGE_EXT.test(path)) return 'image';
  if (/\.webm$/i.test(path)) return /동영상|영상|video/i.test(alt) ? 'video' : 'audio';
  if (VIDEO_EXT.test(path)) return 'video';
  if (AUDIO_EXT.test(path)) return 'audio';
  return null;
}
export const isAudio = (src, alt) => mediaKindOf(src, alt) === 'audio';

export function isBlankBody(body) {
  return plainLines(body).length === 0 && extractAttachments(body).length === 0;
}

// ---------- 같은 메모를 두 기기에서 동시에 고쳤을 때 ----------
// 열어 둔 메모에 아직 저장하지 않은 글이 있는데 다른 기기(동기화)에서 바뀐 내용이 들어오면, 지금 쓰는 글은 그대로 두고
// 들어온 내용은 사본 메모로 남긴다 — 아무것도 잃지 않게 (Drive 동기화의 "(PC 충돌 …)" 사본과 같은 생각)
//   사본 제목: "회의 메모 (다른 기기 10월 5일 08:34)"

/** 같은 본문인가 — 파일에 쓸 때 줄바꿈(\r\n)·끝 공백을 맞추므로 그만큼은 같은 것으로 본다 */
export function sameBody(a, b) {
  const norm = (v) => String(v ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return norm(a) === norm(b);
}

export function conflictLabel(date = new Date()) {
  return `다른 기기 ${koMonthDay(date)} ${hhmm(date)}`;
}

/** 사본 본문: 첫 줄(제목)에 "(다른 기기 …)" 를 붙인다. 제목 줄이 없으면 제목 줄을 만든다 */
export function conflictCopyBody(body, label = conflictLabel()) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i >= 0 && /^\s{0,3}#{1,6}\s+\S/.test(lines[i])) lines[i] = `${lines[i].trimEnd()} (${label})`;
  else lines.splice(Math.max(0, i), 0, `# ${extractTitle(text)} (${label})`, '');
  return lines.join('\n');
}

// ---------- 파일명 ----------

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// 윈도우·안드로이드·Google Drive 모두에서 안전한 파일명 (확장자 제외)
export function titleToFileName(title) {
  let name = title
    .replace(/[<>:"/\\|?*#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/^(~\$\s*)+/, '') // ~$ 로 시작하는 파일은 오피스 임시 파일로 보고 목록에서 빼므로
    .slice(0, 60)
    .trim();
  if (!name) name = UNTITLED;
  // 윈도우는 점 뒤가 있어도(con.txt) 장치 이름으로 본다 → 만들 수 없는 파일
  if (RESERVED.test(name.split('.')[0].trim())) name = name.replace(/^([^.]*?)(\s*)(?=\.|$)/, '$1_$2');
  return name;
}
