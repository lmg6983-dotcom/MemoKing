import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUnicodeRange, fontFacesFor } from '../app/js/core/font-subset.js';

test('글꼴 조각 고르기: 글에 나오는 글자를 가진 조각만', () => {
  assert.deepEqual(parseUnicodeRange('U+AC00-D7A3, U+0041, U+4??'), [[0xac00, 0xd7a3], [0x41, 0x41], [0x400, 0x4ff]]);
  const face = (n, range) => `@font-face { font-family: "P"; src: url(${n}.woff2); unicode-range: ${range}; }`;
  const css = `${face('ko', 'U+AC00-D7A3')}\n${face('latin', 'U+0020-007E')}\n${face('cjk', 'U+4E00-9FFF')}\n@font-face { font-family: "X"; src: url(x.woff2); }`;
  const out = fontFacesFor(css, '메모 Hi');
  assert.ok(out.includes('ko.woff2') && out.includes('latin.woff2'), '한글 · 영문 조각');
  assert.ok(!out.includes('cjk.woff2'), '나오지 않는 한자 조각은 뺀다');
  assert.ok(out.includes('x.woff2'), 'unicode-range 가 없는 규칙은 그대로');
  assert.equal(fontFacesFor(css, ''), '@font-face { font-family: "X"; src: url(x.woff2); }', '글이 없으면 범위 있는 조각은 모두 뺀다');
  // 실제 Pretendard 나눠 읽기 css: 모든 한글 음절이 어느 조각엔가 있다 (조각 고르기가 글자를 놓치지 않는지)
  const real = readFileSync(new URL('../app/vendor/fonts/pretendard/pretendard.css', import.meta.url), 'utf8');
  for (const ch of '가힣메모킹똠방각하') assert.ok(fontFacesFor(real, ch).includes('@font-face'), `${ch} 를 가진 조각`);
});
