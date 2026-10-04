// 메모 파일(.md) 형식 — 머리말(YAML frontmatter) + 마크다운 본문.
// Node(데스크탑 메인)와 브라우저(화면, 추후 안드로이드) 양쪽에서 쓰는 순수 함수만 둔다.
import { parse as parseYaml, stringify as stringifyYaml } from '../../vendor/yaml.js';
import { tableLineText } from './tables.js';
import { toLocalIso } from './time.js';
import { normalizeReminder, serializeReminder } from './reminders.js';
import { normalizeTables } from './table-sizes.js';

export const COLORS = ['yellow', 'green', 'pink', 'purple', 'blue', 'gray', 'charcoal'];
export const DEFAULT_COLOR = 'yellow';
export const UNTITLED = '제목 없음';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KNOWN_KEYS = ['id', 'created', 'updated', 'color', 'pinned', 'links', 'reminders', 'tables'];
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
    extra,
  };
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

// 한 줄의 마크다운 기호를 걷어내 사람이 읽는 글자만 남긴다.
function stripInline(line) {
  return line
    // 줄 끝 \ 는 마크다운 줄바꿈(Shift+Enter) 기호 — 글자가 아니다 (\\ 로 쓴 진짜 역슬래시는 남김)
    .replace(/(^|[^\\])((?:\\\\)*)\\\s*$/, '$1$2')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
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
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
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
export const isVideo = (src, alt) => mediaKindOf(src, alt) === 'video';

export function isBlankBody(body) {
  return plainLines(body).length === 0 && extractAttachments(body).length === 0;
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
    .slice(0, 60)
    .trim();
  if (!name) name = UNTITLED;
  if (RESERVED.test(name)) name += '_';
  return name;
}
