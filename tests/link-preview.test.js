import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeVideoId, youtubeOEmbedUrl, parseYoutubeOEmbed, staleYoutubeEntry } from '../app/js/core/link-preview.js';

test('유튜브 동영상 주소 → 동영상 ID (주소 모양이 달라도 같은 ID)', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abcdef`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}`,
  ]) assert.equal(youtubeVideoId(url), id, url);
});

test('유튜브 동영상이 아닌 주소는 null', () => {
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/@channel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=short',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'not a url',
  ]) assert.equal(youtubeVideoId(url), null, url);
});

test('oEmbed 주소는 동영상 ID 로 정리한 watch 주소', () => {
  assert.equal(
    youtubeOEmbedUrl('https://youtu.be/dQw4w9WgXcQ?si=x'),
    'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ',
  );
  assert.equal(youtubeOEmbedUrl('https://example.com/'), null);
});

test('oEmbed 응답 → 제목 · 채널 · 정해진 썸네일', () => {
  const p = parseYoutubeOEmbed(JSON.stringify({ title: '  노래   제목 ', author_name: '채널 이름', thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' }), 'https://youtu.be/dQw4w9WgXcQ');
  assert.deepEqual(p, {
    title: '노래 제목',
    description: '채널 이름',
    image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    icon: 'https://www.youtube.com/favicon.ico',
    site: 'YouTube',
  });
  assert.equal(parseYoutubeOEmbed('Unauthorized', 'https://youtu.be/dQw4w9WgXcQ').title, '');
});

test('예전 방식으로 받아 둔 유튜브 카드는 다시 받는다 (다른 사이트 · 새 방식은 그대로)', () => {
  assert.equal(staleYoutubeEntry('https://youtu.be/dQw4w9WgXcQ', { title: 'x' }), true);
  assert.equal(staleYoutubeEntry('https://youtu.be/dQw4w9WgXcQ', { kind: 'youtube', title: 'x' }), false);
  // oEmbed 가 안 돼 페이지를 읽은 새 카드는 다시 받지 않는다 (그리기마다 다시 받는 일 없게)
  assert.equal(staleYoutubeEntry('https://youtu.be/dQw4w9WgXcQ', { kind: 'page', title: 'x' }), false);
  assert.equal(staleYoutubeEntry('https://example.com/', { title: 'x' }), false);
  assert.equal(staleYoutubeEntry('https://youtu.be/dQw4w9WgXcQ', undefined), false);
});
