// 매직키 계산기 · 웹 검색 · AI 에게 묻기 (순수 함수, 단위 테스트 대상)
//   계산은 math.js(app/vendor/mathjs.js)로 — 여기서는 계산할 만한 글인지 고르고, 결과를 보기 좋게 적는다.
//   웹 검색 · AI 는 인터넷에 아무것도 보내지 않다가, 고른 줄을 실행할 때만 브라우저로 연다 (메모로 쓰는 글이 밖으로 새지 않게).

const enc = encodeURIComponent;

// 첫 번째가 기본값. 설정에서 고른 사이트가 맨 앞(Enter)으로 온다
export const WEB_ENGINES = [
  { id: 'naver', name: '네이버', url: (q) => `https://search.naver.com/search.naver?query=${enc(q)}` },
  { id: 'google', name: 'Google', url: (q) => `https://www.google.com/search?q=${enc(q)}` },
  { id: 'youtube', name: 'YouTube', url: (q) => `https://www.youtube.com/results?search_query=${enc(q)}` },
  { id: 'bing', name: 'Bing', url: (q) => `https://www.bing.com/search?q=${enc(q)}` },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: (q) => `https://duckduckgo.com/?q=${enc(q)}` },
];

// paste: 주소로 질문을 넘길 수 없는 사이트 — 질문을 복사해 두고 열어서, 붙여 넣기만 하면 되게
export const AI_SITES = [
  { id: 'chatgpt', name: 'ChatGPT', url: (q) => `https://chatgpt.com/?q=${enc(q)}` },
  { id: 'claude', name: 'Claude', url: (q) => `https://claude.ai/new?q=${enc(q)}` },
  { id: 'gemini', name: 'Gemini', url: () => 'https://gemini.google.com/app', paste: true },
  { id: 'perplexity', name: 'Perplexity', url: (q) => `https://www.perplexity.ai/search?q=${enc(q)}` },
];

export const pickId = (list, id) => (list.some((s) => s.id === id) ? id : list[0].id);

/** 고른 사이트를 맨 앞으로 (나머지는 원래 순서) */
export const sitesInOrder = (list, first) => {
  const id = pickId(list, first);
  return [...list.filter((s) => s.id === id), ...list.filter((s) => s.id !== id)];
};

/** 이 사이트에서 이 글을 찾는 주소 { url, paste } — 모르는 사이트면 null */
export function siteLink(list, id, query) {
  const site = list.find((s) => s.id === id);
  const q = String(query ?? '').trim();
  if (!site || !q) return null;
  return { url: site.url(q), paste: Boolean(site.paste), name: site.name };
}

// 사이트 주소처럼 보이면 바로 열 주소 (example.com, www.naver.com/abc, https://…) — 파일 이름(report.pdf)은 아님
const TLD = /\.(com|net|org|kr|io|ai|dev|app|me|so|co|gg|tv|info|biz|xyz|page|site|link|jp|us|uk|edu|gov|ly|to|fm|im|in|cn|de|fr|news|blog|shop|store|cloud|tech|wiki)(\/|:|\?|#|$)/i;
export function siteUrl(text) {
  const s = String(text ?? '').trim();
  if (!s || /\s/.test(s) || s.length > 2000) return null;
  if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s)) return s;
  const host = s.replace(/^www\./i, '');
  if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(host) || !TLD.test(s)) return null;
  return `https://${s}`;
}

/**
 * 계산할 만한 글이면 math.js 에 넘길 식, 아니면 null.
 *   "= 3+4", "1,200 × 3", "15% * 80000", "5 inch to cm", "sqrt(2)" 는 식 · 숫자만 · 날짜 · 전화번호 · 보통 글은 아님
 */
export function calcInput(text) {
  let s = String(text ?? '').trim();
  if (!s || s.includes('\n') || s.length > 200) return null;
  s = s.replace(/^=\s*/, '').replace(/[=\s]+$/, '');
  s = s.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  s = s.replace(/(\d),(?=\d{3}(\D|$))/g, '$1'); // 1,200 → 1200
  if (!/\d/.test(s) || /[가-힣]/.test(s)) return null;
  // 2026-10-22 · 010-1234-5678 · 1.2.3 · 10/22/2026 처럼 숫자를 같은 기호로 두 번 넘게 이은 것은 계산이 아니라 날짜 · 번호
  if (/^\d+([-./])\d+(\1\d+)+$/.test(s)) return null;
  const op = /[+\-*/^%!]|\d\s*\(|\b(sqrt|cbrt|abs|round|floor|ceil|log|log10|log2|exp|sin|cos|tan|asin|acos|atan|pi|e|mod|to|in)\b/;
  if (!op.test(s.replace(/^[+-]/, ''))) return null; // 숫자 하나만은 계산이 아님
  return s;
}

const groupDigits = (s) => s.replace(/^(-?)(\d+)/, (_m, sign, int) => sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

/**
 * 계산 결과 → { value: 보여 줄 글 (천 단위 쉼표), plain: 복사할 글 (쉼표 없이) } 또는 null (숫자 · 단위가 아닌 결과)
 * @param {any} result math.js evaluate 결과
 * @param {(v: any, o: object) => string} format math.js format
 */
export function calcOutput(result, format) {
  if (typeof result === 'number') {
    if (!Number.isFinite(result)) return null;
    const plain = format(result, { precision: 12, lowerExp: -9, upperExp: 21 });
    return { value: /e/.test(plain) ? plain : groupDigits(plain), plain };
  }
  if (result && typeof result === 'object' && result.isUnit === true) {
    const plain = format(result, { precision: 12 });
    return { value: groupDigits(plain), plain };
  }
  return null;
}
