import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockBody, unlockBody, isLockedBody, parseLocked, LOCK_NOTICE } from '../app/js/core/memo-lock.js';
import { extractTitle, plainLines } from '../app/js/core/memo-file.js';
import { extractTags } from '../app/js/core/tags.js';

const FAST = { iterations: 1000 }; // 테스트는 빠르게 (실제는 310000번)
const body = '# 은행 비밀\n\n계좌 1234-5678 #금융\n- [ ] 카드 바꾸기\n![통장](attachments/a.png)\n';

test('잠그면 제목만 보이고 내용·태그·첨부 경로는 숨는다', async () => {
  const locked = await lockBody(body, '사과1234', FAST);
  assert.ok(isLockedBody(locked));
  assert.equal(extractTitle(locked), '은행 비밀');
  assert.ok(locked.includes(LOCK_NOTICE));
  assert.ok(!locked.includes('1234-5678') && !locked.includes('attachments/') && !locked.includes('카드'));
  assert.deepEqual(extractTags(locked), []);
  assert.ok(plainLines(locked).every((l) => !l.includes('memoking-lock')), '목록 미리보기에 암호문이 보이지 않음');
});

test('같은 비밀번호로만 열린다', async () => {
  const locked = await lockBody(body, '사과1234', FAST);
  assert.equal(await unlockBody(locked, '사과1234'), body);
  await assert.rejects(() => unlockBody(locked, '사과123'), /비밀번호가 달라요/);
});

test('잠글 때마다 소금·IV 가 달라 같은 글도 다른 암호문', async () => {
  const a = parseLocked(await lockBody(body, 'abcd', FAST));
  const b = parseLocked(await lockBody(body, 'abcd', FAST));
  assert.notEqual(a.data, b.data);
  assert.notEqual(a.salt, b.salt);
});

test('짧은 비밀번호는 거절, 잠기지 않은 글은 isLocked=false', async () => {
  await assert.rejects(() => lockBody(body, '12'), /4자 이상/);
  assert.equal(isLockedBody(body), false);
});
