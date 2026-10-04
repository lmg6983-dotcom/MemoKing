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
