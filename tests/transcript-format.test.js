import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTranscript, insertAfterMedia, audioSources, clock } from '../app/js/core/transcript-format.js';

test('다시 받아쓴 글: 말한 사람마다 문단, 처음 말한 순서대로 화자 1·2', () => {
  const md = formatTranscript({
    diarize: true,
    segments: [
      { start: 0, end: 4, speaker: 3, text: '안녕하세요' },
      { start: 4.5, end: 8, speaker: 3, text: '회의를 시작할게요' },
      { start: 9, end: 12, speaker: 0, text: '네 좋아요' },
      { start: 75, end: 80, speaker: 3, text: '*중요* 합니다' },
    ],
  });
  assert.equal(md, '**정확하게 다시 받아쓴 글** · Whisper · 말한 사람 2명\n\n**화자 1** (00:00) 안녕하세요 회의를 시작할게요\n\n**화자 2** (00:09) 네 좋아요\n\n**화자 1** (01:15) \\*중요\\* 합니다');
});

test('다시 받아쓴 글: 말한 사람을 구분하지 않으면 몇 조각마다 문단', () => {
  const md = formatTranscript({ diarize: false, segments: [1, 2, 3].map((i) => ({ start: i * 20, end: i * 20 + 20, speaker: -1, text: `조각${i}` })) }, { perParagraph: 2 });
  assert.equal(md, '**정확하게 다시 받아쓴 글** · Whisper\n\n(00:20) 조각1 조각2\n\n(01:00) 조각3');
  assert.equal(formatTranscript({ segments: [] }), '');
  assert.equal(clock(3725), '1:02:05');
});

test('녹음 줄 바로 아래에 넣기', () => {
  const body = '# 회의\n\n![녹음 10월 4일](attachments/a.m4a)\n\n받아쓴 글\n\n다음 문단';
  assert.equal(insertAfterMedia(body, 'attachments/a.m4a', 'NEW'), '# 회의\n\n![녹음 10월 4일](attachments/a.m4a)\n\nNEW\n\n받아쓴 글\n\n다음 문단');
  assert.equal(insertAfterMedia('# 끝\n\n![x](attachments/a.m4a)', 'attachments/a.m4a', 'NEW'), '# 끝\n\n![x](attachments/a.m4a)\n\nNEW');
  assert.equal(insertAfterMedia('# 없음\n', 'attachments/b.m4a', 'NEW'), '# 없음\n\nNEW\n');
});

test('본문의 소리 파일', () => {
  assert.deepEqual(audioSources('![녹음](attachments/a.m4a)\n![사진](attachments/b.png)\n![회의](attachments/c.MP3)'), [{ alt: '녹음', src: 'attachments/a.m4a' }, { alt: '회의', src: 'attachments/c.MP3' }]);
});
