// 태그 추천 (인터넷·AI 없이, 이 메모 폴더 안의 메모들만 보고) — 기존 태그와 정합성 있게
//   1) 본문에 이미 쓰는 태그(또는 그와 같은 뜻의 말)가 나오면 → 그 기존 태그 (가장 확실)
//   2) 내용이 가장 닮은 메모 몇 개(k개)가 단 태그 → 닮은 만큼 투표 (태그별 중심과의 유사도도 조금)
//   3) 함께 다는 태그: #업무 를 달 때 자주 같이 단 #회의 도
//   4) 새 태그는 마지막에만: 이 메모의 핵심어(명사 위주)로 — 하지만 기존 태그와 사실상 같은 말이면
//      (대소문자·띄어쓰기, 회의록↔회의, 미팅↔회의, 한 글자 오타) 새로 만들지 않고 그 기존 태그로
// 결과: [{ name, score(0~1), reason, sure, existing, why }] — sure 는 저절로 달아도 될 만큼 확실한 기존 태그
import { tokenize, tfidfVectors, cosine } from './indexer.js';
import { extractTags, isValidTag } from './tags.js';
import { plainLines, extractTitle } from './memo-file.js';
import { isHangul, jamoDistance, stem, normalizeTag } from './korean.js';

export const MIN_TEXT = 12; // 이보다 짧은 메모에는 추천하지 않는다 (글자 수)
const K = 7; // 닮은 메모 몇 개의 태그를 볼지

// 같은 뜻의 말 묶음 (한국어·영어) — 묶음 안에 이미 쓰는 태그가 있으면 그것으로.
//   본문에 묶음의 말이 나오면 "확실한" 태그로 저절로 달리므로, 뜻이 넓은 흔한 말은 넣지 않는다
//   (하루 → #일기, 코드 → #개발, 계획 → #일정, "영화를 보고" → #보고서 처럼 엉뚱하게 달리지 않게)
const SYNONYMS = [
  ['회의', '미팅', 'meeting', '회의록', '미팅록'],
  ['할일', '투두', 'todo', '해야할일', '할것'],
  ['아이디어', 'idea', '아이디어노트', '발상'],
  ['장보기', '쇼핑', 'shopping', '살것', '구매목록'],
  ['업무', 'work', '회사', '직장', '회사일'],
  ['공부', '학습', 'study', '스터디'],
  ['여행', 'travel', 'trip', '여행계획'],
  ['건강', '운동', 'health', '헬스', '다이어트'],
  ['가계부', '지출', '예산', 'budget', '돈관리'],
  ['일기', 'diary', '다이어리'],
  ['독서', '책', 'book', 'reading', '읽을거리'],
  ['요리', '레시피', 'recipe', 'cooking'],
  ['개발', '코딩', '프로그래밍', 'dev', 'code'],
  ['디자인', 'design', '시안'],
  ['중요', 'important', '긴급', 'urgent'],
  ['일정', '약속', 'schedule', '스케줄'],
  ['가족', 'family'],
  ['영화', 'movie', 'film'],
  ['음악', 'music', '노래'],
  ['고객', '클라이언트', 'client', 'customer'],
  ['계약', '계약서', 'contract'],
  ['보고서', 'report'],
  ['캡처', '캡쳐', '스크린샷', '화면캡처', 'screenshot', 'capture'],
  ['링크', '웹', '북마크', 'link', 'url', 'web'],
  ['음성', '녹음', 'voice', '음성메모', '보이스'],
  ['공유', '받은글', '스크랩', 'share', 'clip'],
];
const SYN = new Map();
SYNONYMS.forEach((group, i) => group.forEach((w) => SYN.set(normalizeTag(w), i)));

// 핵심어로 쓰지 않을 말 (흔한 말·때·움직임)
const STOP = new Set(['오늘', '내일', '어제', '이번', '다음', '지난', '정리', '메모', '내용', '관련', '진행', '확인', '사항', '부분', '경우', '정도',
  '사람', '생각', '이것', '그것', '저것', '우리', '그냥', '정말', '진짜', '시간', '때문', '하나', '여기', '거기', '무엇', '어디', '언제', '모두', '전체',
  '주간', '월간', '오전', '오후', '이번주', '다음주', '지난주', 'the', 'and', 'for', 'with', 'this', 'that']);
// 움직임·꾸밈 말의 꼴 (명사가 아닌 것)
//   (멋졌다·갔다 같은 지난 일, 읽은·빠른 같은 꾸밈, 가서·와서 같은 이음도)
const NOT_NOUN = /([았었였졌겠됐왔갔웠렸켰쳤셨텼][다고]|에서|에게|있고|없고|^[가와봐써줘둬놔]서|은|른|하다|했다|한다|하기|하고|해서|하면|하는|했던|되다|된다|됐다|있다|없다|같다|싶다|겠다|이다|이고|이며|어요|아요|해요|세요|니다|는데|지만|으면|려고|도록|면서|어서|아서|할|될|던|았|었|게|히|이|기|음|임)$/;

const keyOf = (name) => normalizeTag(name);
// 본문에 이 말이 낱말로 나오는가: 줄기가 같거나 줄기가 이 말로 시작 (세 글자 이상이면 글 속 어디든)
const mentions = (word, stems, lower) => {
  const w = keyOf(word);
  if (w.length < 2) return false;
  if (stems.has(w)) return true;
  for (const t of stems) if (t.startsWith(w) && t.length - w.length <= 2) return true;
  return w.length >= 3 && lower.includes(w);
};
// 웹 주소는 태그 거리에서 뺀다 (example.com → "#com" 처럼 엉뚱한 추천이 나왔다)
const noUrls = (text) => text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
const textOf = (body) => {
  const title = extractTitle(body);
  return noUrls(`${title} ${title} ${plainLines(body).join(' ')}`);
};

/** 기존 태그 중 이 말과 사실상 같은 것 (없으면 null) */
export function matchExisting(word, existing) {
  const k = keyOf(word);
  if (!k) return null;
  let best = null;
  for (const t of existing) {
    const tk = keyOf(t.name);
    let rank = 0;
    if (tk === k) rank = 4; // 대소문자·띄어쓰기만 다름
    else if (SYN.has(k) && SYN.get(k) === SYN.get(tk)) rank = 3; // 같은 뜻 묶음
    else if (isHangul(k) && isHangul(tk) && Math.min(k.length, tk.length) >= 2 && (k.startsWith(tk) || tk.startsWith(k)) && Math.abs(k.length - tk.length) <= 2) rank = 2; // 회의 ↔ 회의록
    else if (isHangul(k) && k.length >= 3 && k.length === tk.length && jamoDistance(k, tk) <= 1) rank = 1; // 한 글자 오타
    if (rank && (!best || rank > best.rank || (rank === best.rank && t.count > best.count))) best = { ...t, rank };
  }
  return best;
}

/**
 * @param {string} body 태그를 추천할 메모 본문
 * @param {{ id?: string, body: string }[]} memos 메모 폴더의 다른 메모들
 * @param {{ limit?: number, excludeId?: string }} [options]
 */
export function suggestTagsFor(body, memos, { limit = 3, excludeId } = {}) {
  const plain = noUrls(plainLines(body).join(' '));
  if (plain.replace(/\s/g, '').length < MIN_TEXT) return [];
  const own = new Set(extractTags(body).map(keyOf));
  const others = memos.filter((m) => m.id !== excludeId && m.body !== body);
  const docs = [textOf(body), ...others.map((m) => textOf(m.body))].map(tokenize);
  const vectors = tfidfVectors(docs);
  const target = vectors[0];
  const stems = new Set(docs[0].map((t) => stem(t)));
  const lower = plain.toLocaleLowerCase('ko');
  const tagsOf = others.map((m) => extractTags(m.body));

  // 기존 태그: 이름·쓴 횟수·묶음 중심
  const groups = new Map(); // key → { name, count, centroid }
  tagsOf.forEach((tags, i) => {
    for (const name of tags) {
      const key = keyOf(name);
      const g = groups.get(key) ?? { name, count: 0, centroid: new Map() };
      g.count++;
      for (const [t, w] of vectors[i + 1]) g.centroid.set(t, (g.centroid.get(t) ?? 0) + w);
      groups.set(key, g);
    }
  });
  const existing = [...groups.values()].map((g) => ({ name: g.name, count: g.count }));

  // 닮은 메모 k개의 태그 투표
  const sims = others.map((_, i) => ({ i, s: cosine(target, vectors[i + 1]) })).filter((x) => x.s > 0.05).sort((a, b) => b.s - a.s).slice(0, K);
  const simTotal = sims.reduce((a, x) => a + x.s, 0) || 1;
  const votes = new Map(); // key → { share, n }
  for (const { i, s } of sims) {
    for (const name of tagsOf[i]) {
      const v = votes.get(keyOf(name)) ?? { share: 0, n: 0 };
      v.share += s / simTotal;
      v.n++;
      votes.set(keyOf(name), v);
    }
  }

  const scored = new Map(); // key → result
  const put = (r) => {
    const k = keyOf(r.name);
    if (own.has(k)) return;
    const prev = scored.get(k);
    r.rank ??= r.score;
    if (!prev || r.rank > prev.rank) scored.set(k, r);
  };

  for (const [key, g] of groups) {
    let norm = 0;
    for (const w of g.centroid.values()) norm += w * w;
    norm = Math.sqrt(norm) || 1;
    const centroid = new Map([...g.centroid].map(([t, w]) => [t, w / norm]));
    const sim = cosine(target, centroid);
    const vote = votes.get(key);
    // 태그 이름(또는 같은 뜻 말)이 본문에 낱말로 나오는가
    const parts = tokenize(g.name.replace(/[_-]+/g, ' ')).map(stem);
    let mention = key.length >= 2 && ((parts.length > 0 && parts.every((p) => mentions(p, stems, lower))) || mentions(key, stems, lower));
    let via = null;
    if (!mention && SYN.has(key)) {
      const group = SYNONYMS[SYN.get(key)];
      via = group.find((w) => keyOf(w) !== key && mentions(w, stems, lower));
      if (via) mention = true;
    }
    const popularity = Math.min(0.06, Math.log2(1 + g.count) * 0.015);
    const voteScore = vote ? vote.share * 0.6 + Math.min(0.15, vote.n * 0.04) : 0;
    // 본문에 그대로 나온 태그 > 같은 뜻 말로 나온 태그 > 닮은 메모의 태그
    const raw = (mention ? (via ? 0.6 : 0.7) : 0) + voteScore + sim * 0.35 + popularity;
    const score = Math.min(1, raw);
    if (score < 0.16) continue;
    const reason = mention ? (via ? 'consistent' : 'mention') : vote ? 'similar' : 'centroid';
    const why = mention
      ? via ? `본문의 "${via}", 같은 뜻으로 이미 쓰는 태그` : '본문에 나오는 기존 태그'
      : vote ? `내용이 닮은 메모 ${vote.n}개에 달린 태그` : '이 태그를 단 메모들과 내용이 닮음';
    put({ name: g.name, score: Math.round(score * 100) / 100, rank: raw, reason, existing: true, sure: mention || (vote && vote.share >= 0.45 && vote.n >= 2), why });
  }

  // 함께 다는 태그: 추천된 태그 A 와 자주 같이 단 태그 B
  const firstPass = [...scored.values()].sort((a, b) => b.rank - a.rank).slice(0, 3);
  for (const a of firstPass) {
    const ka = keyOf(a.name);
    const withA = tagsOf.filter((tags) => tags.some((t) => keyOf(t) === ka));
    if (withA.length < 2) continue;
    const co = new Map();
    for (const tags of withA) for (const t of tags) if (keyOf(t) !== ka) co.set(keyOf(t), { name: t, n: (co.get(keyOf(t))?.n ?? 0) + 1 });
    for (const [kb, { name, n }] of co) {
      const p = n / withA.length;
      if (p < 0.6 || n < 2 || scored.has(kb)) continue;
      put({ name, score: Math.round(a.score * p * 0.6 * 100) / 100, reason: 'related', existing: true, sure: false, why: `#${a.name} 와 자주 같이 다는 태그` });
    }
  }

  let out = [...scored.values()].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, 'ko'));

  // 새 태그는 기존 태그로 못 채웠을 때만: 핵심어(명사 위주, 제목 우대) — 기존 태그와 같은 말이면 그 태그로
  if (out.length < limit) {
    const title = new Set(tokenize(extractTitle(body)).map(stem));
    const words = [...target.entries()]
      .map(([t, w]) => [stem(stem(t)), w * (title.has(stem(t)) ? 2 : 1)]) // 폰에서도 → 폰에서 → 폰 (조사가 겹쳐도)
      .filter(([t]) => t.length >= 2 && t.length <= 10 && isValidTag(t) && !STOP.has(t) && !/\d/.test(t) && !(isHangul(t) && NOT_NOUN.test(t)) && !/[a-z].*(에서|에게)/.test(t)) // pc에서고침 처럼 영어+조사가 붙은 말도
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const seen = new Set();
    for (const [t, w] of words) {
      if (out.length >= limit) break;
      if (seen.has(t)) continue;
      seen.add(t);
      const match = matchExisting(t, existing);
      if (match) {
        if (own.has(keyOf(match.name)) || out.some((o) => keyOf(o.name) === keyOf(match.name))) continue;
        out.push({ name: match.name, score: Math.round(Math.min(0.5, 0.2 + w * 0.3) * 100) / 100, reason: 'consistent', existing: true, sure: match.rank >= 3, why: `"${t}" 대신 이미 쓰는 #${match.name}` });
      } else if (!own.has(keyOf(t)) && !out.some((o) => keyOf(o.name) === keyOf(t))) {
        out.push({ name: t, score: Math.round(Math.min(0.15, w * 0.3) * 100) / 100, reason: 'keyword', existing: false, sure: false, why: '이 메모의 핵심어 (새 태그)' });
      }
    }
  }
  out = out.sort((a, b) => Number(b.existing) - Number(a.existing) || (b.rank ?? b.score) - (a.rank ?? a.score));
  return out.slice(0, limit).map(({ rank, ...r }) => r);
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
