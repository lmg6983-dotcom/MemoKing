import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceCardMarkdown, attachTranscript, transcriptLines } from '../app/js/core/voice-card.js';

test('음성 카드: 소리 + 문장마다 한 줄 + 화자 이름표', () => {
  const md = voiceCardMarkdown({ alt: '녹음 · 00:12', src: 'attachments/a.m4a' }, '화자 1: 안녕하세요.\n오늘 #안건 입니다.\n\n화자 2: 네');
  assert.equal(md, '> ![녹음 · 00:12](attachments/a.m4a)\n>\n> **화자 1:** 안녕하세요.\n>\n> 오늘 \\#안건 입니다.\n>\n> **화자 2:** 네');
  assert.equal(voiceCardMarkdown({ alt: 'x', src: 'attachments/a b.m4a' }), '> ![x](<attachments/a b.m4a>)');
});

test('받아쓴 글은 마크다운으로 읽히지 않게', () => {
  assert.deepEqual(transcriptLines('- 하나\n1. 둘\n*강조*'), ['\\- 하나', '1\\. 둘', '\\*강조\\*']);
});

test('받아쓴 글 붙이기: 소리 줄 → 카드, 이미 카드면 끝에 이어서', () => {
  const body = '# 제목\n\n![미팅](attachments/m.m4a)\n\n끝';
  const once = attachTranscript(body, 'attachments/m.m4a', '하나.\n둘.');
  assert.equal(once, '# 제목\n\n> ![미팅](attachments/m.m4a)\n>\n> 하나.\n>\n> 둘.\n\n끝');
  const twice = attachTranscript(once, 'attachments/m.m4a', '셋.');
  assert.equal(twice, '# 제목\n\n> ![미팅](attachments/m.m4a)\n>\n> 하나.\n>\n> 둘.\n>\n> 셋.\n\n끝');
  assert.equal(attachTranscript(body, 'attachments/none.m4a', '하나'), null);
});

test('녹음 길이·때 표시 (휴대폰·PC 같은 모양)', async () => {
  const { recordingClock, recordingWhen } = await import('../app/js/core/voice-card.js');
  assert.equal(recordingClock(0), '00:00');
  assert.equal(recordingClock(151_900), '02:31');
  assert.equal(recordingClock(3_751_000), '1:02:31');
  assert.equal(recordingClock(-5), '00:00');
  assert.equal(recordingWhen(new Date(2026, 9, 4, 15, 12).getTime()), '10월 4일 오후 3:12');
  assert.equal(recordingWhen(new Date(2026, 9, 4, 0, 5).getTime()), '10월 4일 오전 12:05');
});

test('PC 녹음: 만들 수 있는 형식 고르기 · 마이크 오류 안내', async () => {
  const { pickFormat, micErrorText } = await import('../app/js/voice-recorder.js');
  assert.deepEqual(pickFormat((m) => m.startsWith('audio/mp4')), { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' });
  assert.deepEqual(pickFormat((m) => m === 'audio/mp4;codecs=opus'), { mime: 'audio/mp4;codecs=opus', ext: 'm4a' });
  assert.deepEqual(pickFormat((m) => m.startsWith('audio/webm')), { mime: 'audio/webm;codecs=opus', ext: 'weba' });
  assert.equal(pickFormat(() => false), null);
  assert.match(micErrorText({ name: 'NotAllowedError' }), /개인 정보/);
  assert.match(micErrorText({ name: 'NotFoundError' }), /찾지 못했/);
  assert.match(micErrorText(new Error('x')), /시작하지 못했/);
});
