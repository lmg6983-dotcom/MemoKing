// 태그가 없는 메모에 붙일 태그 추천 (인터넷·AI 없이, 이 메모 폴더 안의 메모들만 보고)
//   1) 이미 쓰는 태그 이름이 본문에 낱말로 나오면 → 그 태그 (가장 확실)
//   2) 그 태그를 단 메모들과 내용이 닮았으면 → 그 태그 (태그별 메모 묶음의 TF-IDF 중심과 코사인 유사도)
//   3) 쓰는 태그가 거의 없으면 → 이 메모의 핵심어(TF-IDF)로 새 태그
// 결과: [{ name, score(0~1), reason: 'mention'|'similar'|'keyword', sure }] — sure 는 자동으로 달아도 될 만큼 확실한 것
import { tokenize, tfidfVectors, cosine } from './indexer.js';
import { extractTags, isValidTag } from './tags.js';
import { plainLines, extractTitle } from './memo-file.js';

const keyOf = (name) => name.toLocaleLowerCase('ko');
const textOf = (body) => {
  const title = extractTitle(body);
  return `${title} ${title} ${plainLines(body).join(' ')}`;
};

export const MIN_TEXT = 12; // 이보다 짧은 메모에는 추천하지 않는다 (글자 수)

/**
 * @param {string} body 태그를 추천할 메모 본문
 * @param {{ id?: string, body: string }[]} memos 메모 폴더의 다른 메모들
 * @param {{ limit?: number, excludeId?: string }} [options]
 */
export function suggestTagsFor(body, memos, { limit = 3, excludeId } = {}) {
  const plain = plainLines(body).join(' ');
  if (plain.replace(/\s/g, '').length < MIN_TEXT) return [];
  const own = new Set(extractTags(body).map(keyOf));
  const others = memos.filter((m) => m.id !== excludeId && m.body !== body);
  const docs = [textOf(body), ...others.map((m) => textOf(m.body))].map(tokenize);
  const vectors = tfidfVectors(docs);
  const target = vectors[0];
  const tokens = new Set(docs[0]);
  const lower = plain.toLocaleLowerCase('ko');

  // 태그마다 그 태그를 단 메모들의 벡터를 더한 중심
  const groups = new Map(); // key → { name, count, centroid: Map }
  others.forEach((m, i) => {
    for (const name of extractTags(m.body)) {
      const key = keyOf(name);
      const g = groups.get(key) ?? { name, count: 0, centroid: new Map() };
      g.count++;
      for (const [t, w] of vectors[i + 1]) g.centroid.set(t, (g.centroid.get(t) ?? 0) + w);
      groups.set(key, g);
    }
  });

  const out = [];
  for (const [key, g] of groups) {
    if (own.has(key)) continue;
    let norm = 0;
    for (const w of g.centroid.values()) norm += w * w;
    norm = Math.sqrt(norm) || 1;
    const centroid = new Map([...g.centroid].map(([t, w]) => [t, w / norm]));
    const sim = cosine(target, centroid);
    // 태그 이름이 본문에 낱말로 나오는가 ("회의" 태그 ↔ "회의록을" 처럼 조사·붙은 말도)
    const parts = tokenize(g.name.replace(/[_-]+/g, ' '));
    const mention = key.length >= 2 && (parts.length > 0 && parts.every((p) => tokens.has(p) || [...tokens].some((t) => t.startsWith(p))) || lower.includes(key));
    const popularity = Math.min(0.08, g.count * 0.01);
    const score = Math.min(1, (mention ? 0.75 : 0) + sim * (mention ? 0.5 : 1.2) + popularity);
    if (score < 0.18) continue;
    out.push({ name: g.name, score: Math.round(score * 100) / 100, reason: mention ? 'mention' : 'similar', sure: mention || sim >= 0.35 });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ko'));

  // 쓰는 태그로 못 찾았으면 이 메모의 핵심어로 (글자가 있는 낱말, 두 글자 이상)
  if (out.length < limit && groups.size < 5) {
    const taken = new Set([...own, ...out.map((t) => keyOf(t.name))]);
    const keywords = [...target.entries()]
      .filter(([t]) => /\p{L}{2,}/u.test(t) && isValidTag(t) && !taken.has(t) && t.length <= 12)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit - out.length);
    for (const [t, w] of keywords) out.push({ name: t, score: Math.round(Math.min(0.15, w * 0.3) * 100) / 100, reason: 'keyword', sure: false });
  }
  return out.slice(0, limit);
}

/** 본문 끝에 태그 줄을 붙인 새 본문 (끝 줄이 이미 태그만 있는 줄이면 그 줄에 이어서) */
export function appendTags(body, names) {
  const tags = names.filter(isValidTag).map((n) => `#${n}`);
  if (!tags.length) return body;
  const text = String(body ?? '').replace(/\s+$/, '');
  const lines = text.split('\n');
  const last = lines.at(-1) ?? '';
  if (/^(\s*#[^\s#]+)+\s*$/u.test(last) && extractTags(last).length) {
    lines[lines.length - 1] = `${last.trimEnd()} ${tags.join(' ')}`;
    return `${lines.join('\n')}\n`;
  }
  return `${text}\n\n${tags.join(' ')}\n`;
}
