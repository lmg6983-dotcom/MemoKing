// LLM 에이전트용 인덱스(index.json) 생성 — 요약·키워드·연결·관련도.
// 에이전트가 이 파일만 먼저 읽고 관련도 높은 메모 파일에 바로 접근할 수 있게 한다.
import { extractTags } from './tags.js';
import { plainLines, extractTitle, extractHeadings, extractAttachments } from './memo-file.js';

export const INDEX_SCHEMA = 'memoking.index/v1';
const SUMMARY_LENGTH = 200;
const KEYWORD_COUNT = 6;
const RELATED_COUNT = 8;
const SIMILAR_MIN = 0.08;

// 한국어 조사·어미 (긴 것부터 떼어낸다)
const JOSA = [
  '에서부터', '으로부터', '이라는', '이라고', '에게서', '한테서', '까지는', '부터는', '에서는', '으로는',
  '이에요', '입니다', '했다', '에서', '에게', '한테', '으로', '까지', '부터', '처럼', '보다', '라는', '이나',
  '하고', '이다', '이랑', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만', '랑', '나',
];
const STOPWORDS = new Set([
  '그리고', '그러나', '하지만', '그래서', '또는', '이것', '저것', '그것', '있다', '없다', '하다', '되다',
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'you', 'not', 'but', 'from', 'have',
]);

export function tokenize(text) {
  const tokens = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    let word = raw;
    if (/\p{Script=Hangul}$/u.test(word)) {
      // 뗀 뒤 두 글자 이상 남을 때만 뗀다 ("사과" 의 "과" 는 조사가 아님)
      const josa = JOSA.find((j) => word.length - j.length >= 2 && word.endsWith(j));
      if (josa) word = word.slice(0, -josa.length);
    }
    if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    tokens.push(word);
  }
  return tokens;
}

// 제목을 뺀 본문 앞부분을 문장 단위로 잘라 요약으로 쓴다 (추출 요약).
export function summarize(body) {
  const lines = plainLines(body).slice(1);
  let summary = '';
  for (const line of lines) {
    const next = summary ? `${summary} ${line}` : line;
    if (next.length > SUMMARY_LENGTH) {
      if (!summary) summary = `${line.slice(0, SUMMARY_LENGTH - 1)}…`;
      else summary += ' …';
      break;
    }
    summary = next;
  }
  return summary;
}

export function tfidfVectors(docs) {
  const df = new Map();
  const tfs = docs.map((tokens) => {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return tf;
  });
  const n = docs.length;
  return tfs.map((tf) => {
    const vec = new Map();
    let norm = 0;
    for (const [t, count] of tf) {
      const w = (1 + Math.log(count)) * Math.log(1 + n / df.get(t));
      vec.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });
}

export function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [t, w] of small) {
    const other = large.get(t);
    if (other) sum += w * other;
  }
  return sum;
}

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {{ id: string, file: string, meta: object, body: string }[]} memos
 * @param {{ now?: string }} [options]
 */
export function buildIndex(memos, { now } = {}) {
  const sorted = [...memos].sort((a, b) => a.file.localeCompare(b.file, 'ko'));
  const ids = new Set(sorted.map((m) => m.id));
  const titles = new Map(sorted.map((m) => [m.id, extractTitle(m.body)]));

  // 제목은 두 번 넣어 가중치를 높인다.
  const vectors = tfidfVectors(sorted.map((m) => tokenize(`${titles.get(m.id)} ${titles.get(m.id)} ${plainLines(m.body).join(' ')}`)));

  const links = new Map(sorted.map((m) => [m.id, m.meta.links.filter((id) => ids.has(id) && id !== m.id)]));
  const backlinks = new Map(sorted.map((m) => [m.id, []]));
  for (const [from, targets] of links) for (const to of targets) backlinks.get(to).push(from);

  const entries = sorted.map((memo, i) => {
    const vec = vectors[i];
    const keywords = [...vec.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, KEYWORD_COUNT)
      .map(([t]) => t);

    const out = links.get(memo.id);
    const back = backlinks.get(memo.id);
    const related = [];
    sorted.forEach((other, j) => {
      if (j === i) return;
      const similarity = cosine(vec, vectors[j]);
      const reasons = [];
      let score = 0;
      if (out.includes(other.id)) { reasons.push('link'); score += 0.6; }
      if (back.includes(other.id)) { reasons.push('backlink'); score += 0.4; }
      if (similarity >= SIMILAR_MIN) { reasons.push('similar'); score += similarity; }
      if (reasons.length) {
        related.push({ id: other.id, file: other.file, title: titles.get(other.id), score: round(Math.min(1, score)), similarity: round(similarity), reasons });
      }
    });
    related.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file, 'ko'));

    return {
      id: memo.id,
      file: memo.file,
      title: titles.get(memo.id),
      summary: summarize(memo.body),
      headings: extractHeadings(memo.body),
      tags: extractTags(memo.body),
      keywords,
      created: memo.meta.created,
      updated: memo.meta.updated,
      color: memo.meta.color,
      pinned: memo.meta.pinned,
      chars: plainLines(memo.body).join('').length,
      attachments: extractAttachments(memo.body),
      links: out,
      backlinks: back,
      related: related.slice(0, RELATED_COUNT),
    };
  });

  return {
    schema: INDEX_SCHEMA,
    generatedAt: now ?? new Date().toISOString(),
    guide: '_memoking/README.md',
    memoCount: entries.length,
    memos: entries,
  };
}

// generatedAt 만 다른 경우는 같은 인덱스로 본다 (불필요한 동기화 방지).
export function sameIndex(a, b) {
  if (!a || !b) return false;
  return JSON.stringify({ ...a, generatedAt: null }) === JSON.stringify({ ...b, generatedAt: null });
}

export const AGENT_GUIDE = `# 메모킹 폴더 안내 (LLM 에이전트용)

이 폴더는 메모킹 앱의 메모 저장소입니다. **먼저 \`_memoking/index.json\` 을 읽고**, 필요한 메모 파일만 여세요.

## 구조
- \`*.md\` — 메모 1개 = 파일 1개. YAML 머리말 + 마크다운 본문. 첫 줄이 제목, 파일명도 제목을 따름.
- \`attachments/\` — 메모에 넣은 파일. 이미지·소리·동영상은 \`![설명](attachments/파일)\`, 그 밖의 파일은 \`[파일명](attachments/파일)\` 로 참조.
- 본문 서식은 마크다운 + 일부 인라인 HTML: 밑줄 \`<u>\`, 하이라이트 \`<mark>\`, 글자 색 \`<span style="color: …">\` (태그를 빼면 글자만 남음).
- 링크 카드: 한 줄에 \`[페이지 제목](주소 "미리보기")\` 만 있으면 앱에서 미리보기 카드로 보임. 페이지 설명은 \`_memoking/link-previews.json\` 에 주소별로 있음.
- \`_memoking/index.json\` — 모든 메모의 요약·키워드·연결·관련도 (앱이 자동 갱신).
- \`_memoking/trash/\` — 삭제된 메모 (검색 대상 아님).

## 메모 머리말
| 키 | 뜻 |
|---|---|
| id | 메모 고유 id (파일명이 바뀌어도 유지) |
| created / updated | 만든 시각 / 고친 시각 (ISO 8601) |
| color | 스티커 색 |
| pinned | 목록 맨 위 고정 여부 |
| links | 사용자가 직접 연결한 메모들의 id |

## index.json 의 memos[] 항목
| 키 | 뜻 |
|---|---|
| id, file, title | 메모 id, 폴더 기준 파일 경로, 제목 |
| summary | 본문 앞부분 추출 요약 |
| headings, keywords | 소제목 목록, 핵심어 (TF-IDF) |
| tags | 본문의 #태그 (사용자가 붙인 분류) |
| links / backlinks | 이 메모가 연결한 메모 / 이 메모를 연결한 메모 (id) |
| related | 관련 메모 목록. score(0~1) 높은 순. reasons: link(직접 연결), backlink(역연결), similar(내용 유사) |
| attachments | 첨부 파일 경로 |

## 권장 사용법
1. index.json 에서 title·summary·keywords 로 후보를 찾는다.
2. 후보의 related 를 따라 score 높은 메모를 함께 확인한다.
3. 필요한 메모의 file 을 열어 본문을 읽는다.
`;
