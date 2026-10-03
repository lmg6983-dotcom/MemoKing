// 매직키의 메모 검색 — 띄어 쓴 낱말이 모두 들어간 메모를, 제목에 있는 것·최근 것부터 (순수 함수, 단위 테스트 대상)

/**
 * @param {{ id: string, title: string, text: string, updated?: string, color?: string }[]} memos text = 본문 글(제목 줄 포함 가능)
 * @param {string} query
 * @param {number} [limit]
 * @returns {{ id: string, title: string, snippet: string, color?: string }[]}
 */
export function searchMemos(memos, query, limit = 5) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const found = [];
  for (const m of memos ?? []) {
    const title = String(m.title ?? '');
    const text = String(m.text ?? '');
    const lt = title.toLowerCase();
    const lx = text.toLowerCase();
    if (!terms.every((t) => lt.includes(t) || lx.includes(t))) continue;
    let score = 0;
    if (lt.includes(q)) score += 4; // 제목에 찾는 말 그대로
    if (lt.startsWith(q)) score += 2;
    score += terms.filter((t) => lt.includes(t)).length; // 제목에 든 낱말
    if (lx.includes(q)) score += 1;
    found.push({ m, score, at: Date.parse(m.updated ?? '') || 0 });
  }
  found.sort((a, b) => b.score - a.score || b.at - a.at);
  return found.slice(0, limit).map(({ m }) => ({ id: m.id, title: m.title, color: m.color, snippet: snippetOf(String(m.text ?? ''), terms, m.title) }));
}

// 본문에서 찾은 말 둘레 한 줄 (없으면 첫 줄)
export function snippetOf(text, terms, title = '') {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && l !== title);
  const lower = lines.map((l) => l.toLowerCase());
  let i = lower.findIndex((l) => terms.some((t) => l.includes(t)));
  if (i < 0) i = 0;
  const line = lines[i] ?? '';
  if (line.length <= 60) return line;
  const at = Math.max(0, Math.min(...terms.map((t) => { const k = lower[i].indexOf(t); return k < 0 ? Infinity : k; })) - 20);
  return `${at > 0 ? '…' : ''}${line.slice(at, at + 60)}${at + 60 < line.length ? '…' : ''}`;
}
