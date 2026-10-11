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

test('세션: 한 번 연 열쇠로 저장마다 다시 잠그고 풀기 (동기)', async () => {
  const { newLockSession, sealBody, unsealBody, openLock } = await import('../app/js/core/memo-lock.js');
  const session = await newLockSession('사과1234', FAST);
  const a = sealBody('# 메모\n\n첫 글', session);
  const b = sealBody('# 메모\n\n고친 글', session);
  assert.notEqual(parseLocked(a).iv, parseLocked(b).iv, '저장마다 새 IV');
  assert.equal(parseLocked(a).salt, parseLocked(b).salt, '소금은 그대로 (다른 기기 세션으로도 풀림)');
  assert.equal(unsealBody(b, session), '# 메모\n\n고친 글');
  const other = await openLock(b, '사과1234'); // 다른 기기가 비밀번호로 연 세션
  assert.equal(unsealBody(sealBody('# 메모\n\n휴대폰', other.session), session), '# 메모\n\n휴대폰');
  const relocked = await lockBody('# 메모', '새비밀번호', FAST); // 다른 비밀번호로 다시 잠금 → 이전 세션으로는 못 풂
  assert.equal(unsealBody(relocked, session), null);
});

test('잠금 형식 글을 붙여 넣은 보통 메모는 잠긴 메모가 아니다', async () => {
  const locked = await lockBody(body, '사과1234', FAST);
  const comment = locked.slice(locked.indexOf('<!--'));
  assert.equal(isLockedBody(`# 메모 앱 연구\n\n이런 줄이 파일에 있어요:\n\n${comment}\n그 뒤 글`), false);
  assert.equal(isLockedBody(`# 붙여 넣음\n\n설명 한 줄\n\n${comment}`), false);
  assert.equal(parseLocked(`앞 글 ${comment}`), null);
  // 잠근 파일 그대로(줄 끝 \r\n · 앞 BOM 이어도)는 잠긴 메모
  assert.ok(isLockedBody(locked));
  assert.ok(isLockedBody(`﻿${locked.replace(/\n/g, '\r\n')}`));
  assert.ok(isLockedBody(comment), '제목·안내 없이 암호문만');
});
