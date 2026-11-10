// 받아쓴 글 다듬기 (가볍게, 인터넷·AI 없이)
//   1) 이 메모 폴더의 말모음(태그·제목·소제목에 자주 나온 낱말): 받아쓰기 힌트로도 쓰고(휴대폰 음성 인식),
//   2) 받아쓴 낱말이 말모음의 낱말과 소리가 아주 비슷하면(자모 1~2개 차이) 그 낱말로 고친다 — 사람·회사·제품 이름처럼
//      받아쓰기가 자주 틀리는 고유한 말. 원래 낱말이 이 폴더에서 이미 쓰는 말이면 고치지 않는다
//   3) 띄어쓰기·문장부호 정리
import { extractTags } from './tags.js';
import { extractTitle, extractHeadings } from './memo-file.js';
import { isHangul, jamo, jamoDistance, stem } from './korean.js';

const STOP = new Set(['그리고', '그래서', '하지만', '그러나', '오늘', '내일', '어제', '이번', '다음', '지난', '정리', '메모', '내용', '관련', '진행', '확인', '사항', '부분', '경우', '정도', '사람', '생각', '이것', '그것', '저것', '우리', '그냥', '정말', '진짜']);

/**
 * 말모음: [{ term, weight }] (많이 쓴 순). 태그는 무게 3, 제목·소제목 낱말은 나온 메모 수
 * @param {{ body: string }[]} memos
 */
export function vocabularyFrom(memos, { limit = 120 } = {}) {
  const w = new Map();
  const known = new Set(); // 이 폴더의 글에 한 번이라도 나온 낱말 — 맞게 받아쓴 보통 말("메모장")을 말모음의 말("메모킹")로 바꾸지 않게
  const add = (term, by) => {
    const t = String(term ?? '').trim();
    if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) return;
    w.set(t, (w.get(t) ?? 0) + by);
  };
  for (const m of memos) {
    for (const raw of String(m.body ?? '').split(/[^\p{L}\p{N}]+/u)) if (raw.length >= 2) known.add(stem(raw));
    for (const tag of extractTags(m.body)) add(tag, 3);
    const seen = new Set();
    for (const line of [extractTitle(m.body), ...extractHeadings(m.body)]) {
      for (const raw of String(line).split(/[\s,./()[\]·:;!?'"“”]+/)) {
        const s = stem(raw);
        if (s.length < 2 || seen.has(s) || !(isHangul(s) || /^[a-z][a-z0-9]{2,}$/i.test(s))) continue;
        seen.add(s);
        add(s, 1);
      }
    }
  }
  const list = [...w].filter(([, v]) => v >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')).slice(0, limit).map(([term, weight]) => ({ term, weight }));
  return Object.defineProperty(list, 'known', { value: known }); // fixTranscript 가 쓴다 (목록 모양은 그대로)
}

/** 받아쓴 낱말 하나를 말모음으로 고칠 것이 있으면 그 말 (없으면 null) */
export function correctWord(word, vocab, known) {
  const core = stem(word);
  if (!isHangul(core) || core.length < 2 || known.has(core)) return null;
  const tail = word.slice(word.indexOf(core) + core.length);
  const head = word.slice(0, word.indexOf(core));
  const jc = jamo(core);
  let best = null;
  let tie = false;
  for (const { term } of vocab) {
    if (!isHangul(term) || Math.abs(term.length - core.length) > 0 || term === core) continue;
    const jt = jamo(term);
    if (jt[0] !== jc[0]) continue; // 첫소리는 같아야
    const max = core.length >= 4 ? 2 : 1; // 세 글자에 자모 둘은 다른 낱말이다 (메모장 ↔ 메모킹)
    const d = jamoDistance(core, term);
    if (d > max) continue;
    if (!best || d < best.d) {
      best = { term, d };
      tie = false;
    } else if (d === best.d) tie = true;
  }
  if (!best || tie) return null;
  return `${head}${best.term}${tail}`;
}

/** 받아쓴 글 전체 다듬기 */
export function fixTranscript(text, vocab = []) {
  const known = new Set(vocab.known);
  for (const { term } of vocab) known.add(term);
  const out = String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => {
      const label = line.match(/^\s*화자\s*\d+\s*:\s*/)?.[0] ?? ''; // 말한 사람 이름표는 그대로
      return label + line.slice(label.length).split(' ').map((w) => (w ? correctWord(w, vocab, known) ?? w : w)).join(' ');
    })
    .join('\n');
  return out
    .replace(/ +([.,?!])/g, '$1') // 부호 앞 띄어쓰기
    .replace(/([.?!])(?=[^\s.?!\d])/g, '$1 ') // 부호 뒤 띄어쓰기
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
