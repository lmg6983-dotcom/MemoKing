// 밖에서 들어온 메모(화면 캡처 · 다른 앱에서 공유 · 빠른 메모)에 태그를 저절로 (순수 함수 — 휴대폰·PC 함께)
//   1) 내용에 맞는 기존 태그: 추천 태그 중 확실한 것(최대 2개), 없으면 가장 잘 맞는 기존 태그 하나(점수가 넉넉할 때만)
//   2) 들어온 곳 태그: 화면 캡처는 늘 #캡처, 링크·음성·공유는 내용 태그를 못 찾았을 때만 #링크 · #음성 · #공유
//      — 이미 같은 뜻의 태그를 쓰고 있으면(#스크린샷 등) 그 태그로 (새로 만들지 않는다)
import { suggestTagsFor, matchExisting } from './tag-suggest.js';
import { extractTags, isValidTag } from './tags.js';

export const SOURCE_TAGS = { capture: '캡처', link: '링크', audio: '음성', share: '공유' };

/**
 * @param {string} body 새 메모 본문
 * @param {{ id?: string, body: string }[]} memos 메모 폴더의 메모들
 * @param {{ source?: 'capture'|'link'|'audio'|'share', excludeId?: string }} [options]
 * @returns {string[]} 달 태그 이름 (본문에 이미 있는 것은 빼고)
 */
export function autoTagsFor(body, memos, { source, excludeId } = {}) {
  const own = new Set(extractTags(body).map((t) => t.toLocaleLowerCase('ko')));
  const out = [];
  const add = (name) => {
    const key = String(name).toLocaleLowerCase('ko');
    if (!isValidTag(name) || own.has(key) || out.some((t) => t.toLocaleLowerCase('ko') === key)) return;
    out.push(name);
  };
  let suggestions = [];
  try {
    suggestions = suggestTagsFor(body, memos, { excludeId, limit: 4 }).filter((t) => t.existing);
  } catch {
    suggestions = [];
  }
  const sure = suggestions.filter((t) => t.sure).slice(0, 2);
  if (sure.length) sure.forEach((t) => add(t.name));
  else if (suggestions[0] && suggestions[0].score >= 0.3) add(suggestions[0].name);

  const tag = SOURCE_TAGS[source];
  if (tag && (source === 'capture' || !out.length)) {
    // 이미 쓰는 같은 뜻의 태그가 있으면 그것으로
    const counts = new Map();
    for (const m of memos) for (const t of extractTags(m.body)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const existing = [...counts].map(([name, count]) => ({ name, count }));
    add(matchExisting(tag, existing)?.name ?? tag);
  }
  return out;
}
