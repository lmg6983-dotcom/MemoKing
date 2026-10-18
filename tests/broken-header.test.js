import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoFile, extractTitle, extractPreview } from '../app/js/core/memo-file.js';

test('깨진 머리말: 파일 내용은 본문에 그대로 두고, 제목 · 미리보기는 그 뒤에서', () => {
  const file = '---\nid: [깨짐\ncolor: 없는색\n---\n# 깨진 머리말\n\n그래도 보여야 해요\n';
  const { body } = parseMemoFile(file);
  assert.ok(body.startsWith('---\nid: [깨짐'), '깨진 머리말은 잃지 않게 본문에 남는다');
  assert.equal(extractTitle(body), '깨진 머리말');
  assert.equal(extractPreview(body), '그래도 보여야 해요');
});

test('머리말처럼 보이지 않는 "---" 묶음(한글 글)은 그대로 제목 · 미리보기', () => {
  const body = '---\n주의: 미끄러워요\n---\n본문';
  assert.equal(extractTitle(body), '주의: 미끄러워요');
});
