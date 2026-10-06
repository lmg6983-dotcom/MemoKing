import test from 'node:test';
import assert from 'node:assert/strict';
import { punctuate, joinTranscript, labelSpeakers, tokensToText, SpeechConditioner } from '../app/js/core/transcript-lines.js';

test('문장부호: 묻는 말은 ?, 맺는 말은 ., 이미 있으면 그대로 (휴대폰과 같은 규칙)', () => {
  assert.equal(punctuate('내일 회의 몇 시에 할까요'), '내일 회의 몇 시에 할까요?');
  assert.equal(punctuate('자료는 제가 보낼게요'), '자료는 제가 보낼게요.');
  assert.equal(punctuate('좋아요!'), '좋아요!');
  assert.equal(punctuate('예산 검토'), '예산 검토');
});

test('줄 잇기: 말한 사람이 둘 이상이면 바뀌는 줄 앞에만 "화자 N: ", 모르는 줄은 앞사람', () => {
  assert.equal(joinTranscript([{ text: '안녕하세요' }, { text: '반가워요' }]), '안녕하세요.\n반가워요.');
  assert.equal(joinTranscript([
    { text: '시작할게요', speaker: 1 }, { text: '첫 안건입니다', speaker: 1 }, { text: '네 좋아요', speaker: 2 }, { text: '그리고요', speaker: 0 }, { text: '마칠게요', speaker: 1 },
  ]), '화자 1: 시작할게요.\n첫 안건입니다.\n화자 2: 네 좋아요.\n그리고요.\n화자 1: 마칠게요.');
});

test('말한 사람 붙이기: 시간이 가장 많이 겹친 사람, 번호는 처음 말한 순서대로', () => {
  const lines = [{ text: 'a', start: 0.5, end: 3 }, { text: 'b', start: 4, end: 6 }, { text: 'c', start: 7, end: 9 }, { text: 'd', start: 20, end: 21 }];
  const segs = [{ start: 0.4, end: 3.1, speaker: 5 }, { start: 3.9, end: 6.2, speaker: 0 }, { start: 6.9, end: 7.5, speaker: 0 }, { start: 7.5, end: 9, speaker: 5 }];
  assert.deepEqual(labelSpeakers(lines, segs).map((l) => l.speaker), [1, 2, 1, 1]);
});

test('낱말 조각 → 띄어쓴 글 (▁ 가 낱말 경계)', () => {
  assert.equal(tokensToText(['▁주민', '등록', '증을', '▁보여', '▁주', '시겠어요', '?']), '주민등록증을 보여 주시겠어요?');
  assert.equal(tokensToText([], '그대로'), '그대로');
});

test('소리 다듬기: 낮은 웅웅 소리는 줄이고, 작은 목소리는 키우되 넘치지 않음', () => {
  const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  const tone = (hz) => rms(new SpeechConditioner(16000).process(Float32Array.from({ length: 16000 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * hz * i) / 16000))));
  assert.ok(tone(30) < tone(1000) * 0.5, `30Hz ${tone(30)} / 1000Hz ${tone(1000)}`); // 같은 크기라도 낮은 웅웅 소리는 덜
  const quiet = new SpeechConditioner(16000);
  let out;
  for (let k = 0; k < 30; k++) out = quiet.process(Float32Array.from({ length: 1600 }, (_, i) => 0.02 * Math.sin((2 * Math.PI * 300 * (i + k * 1600)) / 16000)));
  assert.ok(rms(out) > 0.02 * 0.707 * 2, `키움 ${rms(out)}`);
  assert.ok(out.every((v) => v <= 1 && v >= -1));
});
