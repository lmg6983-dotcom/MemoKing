import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jamo, jamoDistance, stem, normalizeTag } from '../app/js/core/korean.js';
import { vocabularyFrom, correctWord, fixTranscript } from '../app/js/core/transcript-fix.js';

test('자모·편집 거리·줄기', () => {
  assert.deepEqual(jamo('업무'), ['ㅇ', 'ㅓ', 'ㅂ', 'ㅁ', 'ㅜ']);
  assert.equal(jamoDistance('업무', '엄무'), 1);
  assert.equal(jamoDistance('회의', '회사'), 2);
  assert.equal(stem('회의록을'), '회의록');
  assert.equal(stem('메모킹에서'), '메모킹');
  assert.equal(stem('사과'), '사과');
  assert.equal(normalizeTag('To-Do'), 'todo');
});

const memos = [
  { body: '# 메모킹 출시 회의\n\n#메모킹 #업무' },
  { body: '# 메모킹 디자인\n\n## 아이콘\n\n#디자인 #업무' },
  { body: '# 김철수 미팅\n\n#김철수' },
];

test('말모음: 태그와 자주 나온 제목 낱말', () => {
  const v = vocabularyFrom(memos).map((t) => t.term);
  assert.ok(v.includes('메모킹'));
  assert.ok(v.includes('업무'));
  assert.ok(v.includes('김철수'));
});

test('받아쓰기 고치기: 소리가 비슷한 이 폴더의 말로, 조사는 그대로', () => {
  const vocab = vocabularyFrom(memos);
  const known = new Set(vocab.map((t) => t.term));
  assert.equal(correctWord('메모칭에서', vocab, known), '메모킹에서');
  assert.equal(correctWord('김철주가', vocab, known), '김철수가');
  assert.equal(correctWord('엄무를', vocab, known), '업무를');
  assert.equal(correctWord('사과를', vocab, known), null); // 비슷한 말 없음
  assert.equal(correctWord('업무를', vocab, known), null); // 이미 맞음
});

test('받아쓴 글 다듬기: 띄어쓰기·부호', () => {
  const vocab = vocabularyFrom(memos);
  assert.equal(fixTranscript('메모칭 회의를 시작합니다 .다음은  엄무 정리', vocab), '메모킹 회의를 시작합니다. 다음은 업무 정리');
});

test('받아쓰기 고치기: 맞게 받아쓴 보통 말은 바꾸지 않는다', () => {
  const vocab = vocabularyFrom([...memos, { body: '# 출시 일정\n\n#출시\n부산 출신 디자이너와 통화' }, { body: '# 출시 점검\n\n#출시' }]);
  const known = new Set([...vocab.known, ...vocab.map((t) => t.term)]);
  assert.ok(vocab.some((t) => t.term === '출시'));
  assert.equal(correctWord('메모장', vocab, known), null, '세 글자에 자모 둘 차이는 다른 낱말');
  assert.equal(correctWord('메모지', vocab, known), null);
  assert.equal(correctWord('출신', vocab, known), null, '이 폴더의 글에 나온 말은 그대로');
  assert.equal(fixTranscript('부산 출신 메모칭 담당자', vocab), '부산 출신 메모킹 담당자');
});
