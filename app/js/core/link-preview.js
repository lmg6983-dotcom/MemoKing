// 링크 미리보기 카드 — 파일에는 평범한 마크다운 링크로, 화면에는 제목·설명·사진이 있는 카드로.
//
//   [페이지 제목](https://example.com/글 "미리보기")
//
// 링크 하나만 있는 문단이고 링크 제목(title)이 "미리보기" 이면 카드로 보여준다.
// 설명·사진은 메모 폴더의 _memoking/link-previews.json 에 모아 두어 다른 PC 에서도 보인다.
// (순수 함수 — 브라우저·Node 양쪽, 단위 테스트 대상)

export const CARD_TITLE = '미리보기';

const URL_ONLY = /^https?:\/\/[^\s<>"'`]+$/i;

// 복사한 글이 주소 하나뿐인가 (앞뒤 공백 무시)
export function loneUrl(text) {
  const t = String(text ?? '').trim();
  if (!URL_ONLY.test(t)) return null;
  try {
    return new URL(t).href;
  } catch {
    return null;
  }
}

// 붙여넣은 HTML 이 그 주소 하나만 담고 있는가 (주소창 복사·"링크 주소 복사"는 HTML 이 없거나 <a> 하나)
export function htmlIsJustLink(html, url) {
  return pastedLinkTitle(html, url) !== null;
}

/**
 * 링크 하나만 복사했을 때 그 링크 글자 (엣지 주소창 복사는 <a href="주소">페이지 제목</a>).
 * @returns {string|null} 제목('' = 글자가 주소 그대로이거나 HTML 없음), 링크 말고 다른 내용이 있으면 null
 */
export function pastedLinkTitle(html, url) {
  if (!html) return '';
  if (/<img\b/i.test(html)) return null;
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|title)\b[\s\S]*?<\/\1>/gi, '');
  const textOf = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  const anchors = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  if (!anchors.length) {
    const text = textOf(body);
    return !text || sameUrl(text, url) ? '' : null;
  }
  if (anchors.length !== 1 || textOf(body.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ''))) return null;
  if (!sameUrl(decodeEntities(attrsOf(`<a ${anchors[0][1]}>`).href ?? ''), url)) return null;
  const text = textOf(anchors[0][2]);
  return sameUrl(text, url) ? '' : text.slice(0, 200);
}

function sameUrl(a, b) {
  try {
    return new URL(a.trim()).href === new URL(b.trim()).href;
  } catch {
    return false;
  }
}

// 카드에 보여줄 사이트 이름 (없으면 주소의 호스트, www. 뺌)
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------- 웹페이지에서 제목·설명·사진 읽기 ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const clean = (s, max) => {
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function attrsOf(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

function absolute(href, base) {
  if (!href) return '';
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * HTML(앞부분만 있어도 됨)에서 미리보기 정보를 읽는다.
 * @returns {{ title: string, description: string, image: string, icon: string, site: string }}
 */
export function parseLinkPreview(html, pageUrl) {
  const head = String(html ?? '').slice(0, 600_000);
  const meta = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  let base = pageUrl;
  const baseTag = head.match(/<base\b[^>]*>/i);
  if (baseTag) base = absolute(attrsOf(baseTag[0]).href, pageUrl) || pageUrl;

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const title = clean(meta['og:title'] || meta['twitter:title'] || titleTag, 200);
  const description = clean(meta['og:description'] || meta['twitter:description'] || meta.description, 300);
  const image = absolute(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'], base);
  const site = clean(meta['og:site_name'] || meta['application-name'] || '', 80);

  let icon = '';
  let best = -1;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
    const size = Number((a.sizes ?? '').split('x')[0]) || (rel.includes('apple-touch-icon') ? 180 : 16);
    // 너무 큰 아이콘보다 32~64px 근처를 고른다
    const score = size >= 32 && size <= 96 ? 1000 - Math.abs(size - 48) : size < 32 ? size : 200 - size / 10;
    const href = absolute(a.href, base);
    if (href && score > best) {
      best = score;
      icon = href;
    }
  }
  if (!icon) icon = absolute('/favicon.ico', base);
  return { title, description, image, icon, site };
}

// 응답 헤더·HTML 앞부분에서 글자 인코딩 찾기 (없으면 utf-8)
export function detectCharset(contentType, headBytesAsLatin1) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = String(headBytesAsLatin1 ?? '').slice(0, 4096);
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  return (fromMeta ?? 'utf-8').toLowerCase();
}

// ---------- 마크다운 ↔ 편집기 ----------

// remark 플러그인: 카드 문단 → { type: 'mkLinkCard', url, title } (편집기가 카드 노드로 읽는다)
export function remarkLinkCards() {
  return (tree) => {
    const walk = (parent) => {
      if (!parent.children) return;
      parent.children = parent.children.map((node) => {
        if (isCardParagraph(node)) {
          const link = node.children[0];
          return { type: 'mkLinkCard', url: link.url, title: textOf(link) };
        }
        if (node.type === 'blockquote' || node.type === 'listItem' || node.type === 'list') walk(node);
        return node;
      });
    };
    walk(tree);
  };
}

function isCardParagraph(node) {
  if (node.type !== 'paragraph' || node.children?.length !== 1) return false;
  const link = node.children[0];
  return link.type === 'link' && link.title === CARD_TITLE && /^https?:/i.test(link.url ?? '');
}

function textOf(node) {
  if (node.value != null) return node.value;
  return (node.children ?? []).map(textOf).join('');
}

// 카드 한 장의 마크다운 (빠른 메모·테스트용)
export function cardMarkdown(url, title) {
  const text = String(title || url).replace(/([\\[\]])/g, '\\$1');
  return `[${text}](${url} "${CARD_TITLE}")`;
}
