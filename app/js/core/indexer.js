// LLM 에이전트용 인덱스(index.json) 생성 — 요약·키워드·연결·관련도.
// 에이전트가 이 파일만 먼저 읽고 관련도 높은 메모 파일에 바로 접근할 수 있게 한다.
import { extractTags } from './tags.js';
import { plainLines, extractTitle, extractHeadings, extractAttachments } from './memo-file.js';
import { TAIL_ANY, TAIL_NOUN, NOUNS } from './korean-nouns.js';

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
// 조사는 앞 글자의 받침과 맞을 때만 뗀다 — "하와이" 의 "이", "소아과" 의 "과", "미술가" 의 "가" 는 조사가 아니다
//   받침 뒤에만: 이 · 은 · 을 · 과 · 으로 · 이나 · 이랑 · 이다 …   받침 없는 글자 뒤에만: 가 · 는 · 를 · 와 · 나 · 랑 · 로(ㄹ 받침 뒤도)
// 받침이 맞아도 끝 글자가 조사가 아닌 낱말은 미리 담아 둔 낱말 묶음(korean-nouns.js)으로 가린다
//   "고양이" · "부서회의" 는 그대로, "고양이를" · "위원회의"(위원회 + 의) · "사회의" 는 조사를 뗀다
const knownNoun = (w) => {
  for (let i = w.length - 2; i >= 0; i--) if (NOUNS.has(w.slice(i))) return true;
  return false;
};
function endsInNoun(word, josa) {
  if (TAIL_ANY.some((n) => word.endsWith(n))) return true;
  return word.length >= 4 && TAIL_NOUN.has(word.slice(-2)) && !knownNoun(word.slice(0, -josa.length));
}
const AFTER_BATCHIM = new Set(['이', '은', '을', '과', '으로', '으로는', '으로부터', '이나', '이랑', '이다', '이에요', '입니다', '이라는', '이라고']);
const AFTER_VOWEL = new Set(['가', '는', '를', '와', '나', '랑', '로', '라는']);
function josaFits(word, josa) {
  const prev = word.charCodeAt(word.length - josa.length - 1) - 0xac00;
  if (prev < 0 || prev > 11171) return true; // 한글 음절이 아니면 그대로
  const batchim = prev % 28;
  if (AFTER_BATCHIM.has(josa)) return batchim !== 0;
  if (AFTER_VOWEL.has(josa)) return batchim === 0 || (josa === '로' && batchim === 8);
  return true;
}
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
      const josa = JOSA.find((j) => word.length - j.length >= 2 && word.endsWith(j) && josaFits(word, j));
      if (josa && !endsInNoun(word, josa)) word = word.slice(0, -josa.length);
    }
    if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    tokens.push(word);
  }
  return tokens;
}

// 제목을 뺀 본문 앞부분을 문장 단위로 잘라 요약으로 쓴다 (추출 요약).
export const summarize = (body) => summaryOf(plainLines(body));
function summaryOf(plain) {
  let summary = '';
  for (const line of plain.slice(1)) {
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
  const plains = sorted.map((m) => plainLines(m.body)); // 본문 다듬기는 메모마다 한 번만 (낱말 · 요약 · 글자 수가 함께 쓴다)
  const vectors = tfidfVectors(sorted.map((m, i) => tokenize(`${titles.get(m.id)} ${titles.get(m.id)} ${plains[i].join(' ')}`)));

  const links = new Map(sorted.map((m) => [m.id, m.meta.links.filter((id) => ids.has(id) && id !== m.id)]));
  const backlinks = new Map(sorted.map((m) => [m.id, []]));
  for (const [from, targets] of links) for (const to of targets) backlinks.get(to).push(from);

  // 같은 낱말을 가진 메모끼리만 곱해 더한다 (역색인) — 모든 메모 쌍을 cosine 으로 비교하면 메모 1000개에 몇 초,
  //   저장할 때마다 메인 프로세스가 그만큼 멈춰 쓰던 글자 · 창 끌기가 툭툭 끊겼다
  const postings = new Map();
  vectors.forEach((vec, i) => {
    for (const [t, w] of vec) (postings.get(t) ?? postings.set(t, []).get(t)).push(i, w);
  });
  const sims = new Float64Array(sorted.length);
  const entries = sorted.map((memo, i) => {
    const vec = vectors[i];
    sims.fill(0);
    for (const [t, w] of vec) {
      const p = postings.get(t);
      for (let k = 0; k < p.length; k += 2) sims[p[k]] += w * p[k + 1];
    }
    const keywords = [...vec.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, KEYWORD_COUNT)
      .map(([t]) => t);

    const out = links.get(memo.id);
    const back = backlinks.get(memo.id);
    // 점수만 먼저 모아 위 몇 개만 고른다 (동점은 파일 이름 순 = sorted 의 차례 j). 모든 후보를 글자 비교로 정렬하던 것이 느렸다
    const scored = [];
    for (let j = 0; j < sorted.length; j++) {
      if (j === i) continue;
      const id = sorted[j].id;
      const score = (out.includes(id) ? 0.6 : 0) + (back.includes(id) ? 0.4 : 0) + (sims[j] >= SIMILAR_MIN ? sims[j] : 0);
      if (score > 0) scored.push([round(Math.min(1, score)), j]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const related = scored.slice(0, RELATED_COUNT).map(([score, j]) => {
      const other = sorted[j];
      const reasons = [];
      if (out.includes(other.id)) reasons.push('link');
      if (back.includes(other.id)) reasons.push('backlink');
      if (sims[j] >= SIMILAR_MIN) reasons.push('similar');
      return { id: other.id, file: other.file, title: titles.get(other.id), score, similarity: round(sims[j]), reasons };
    });

    return {
      id: memo.id,
      file: memo.file,
      title: titles.get(memo.id),
      summary: summaryOf(plains[i]),
      headings: extractHeadings(memo.body),
      tags: extractTags(memo.body),
      keywords,
      created: memo.meta.created,
      updated: memo.meta.updated,
      color: memo.meta.color,
      pinned: memo.meta.pinned,
      chars: plains[i].join('').length,
      attachments: extractAttachments(memo.body),
      links: out,
      backlinks: back,
      related,
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

// generatedAt 만 다른 경우는 같은 인덱스로 본다 (불필요한 동기화 방지)
export const indexKey = (index) => JSON.stringify({ ...index, generatedAt: null });

/**
 * 색인과 파일에 쓸 글, 비교 열쇠(generatedAt 만 다르면 같은 색인 — 불필요한 동기화 방지).
 *   큰 JSON 만들기까지 작업 스레드(desktop/index-worker.js)에서 끝내 메인 프로세스는 받아 쓰기만
 */
export function indexOutput(memos) {
  const index = buildIndex(memos);
  return { index, key: indexKey(index), text: `${JSON.stringify(index, null, 2)}\n` };
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

## index.json의 memos[] 항목
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
1. index.json에서 title·summary·keywords로 후보를 찾는다.
2. 후보의 related를 따라 score 높은 메모를 함께 확인한다.
3. 필요한 메모의 file을 열어 본문을 읽는다.
`;
