import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupToEntry, popupAppName, isRepeat } from '../app/js/core/popup-notify.js';

test('팝업 글: 첫 줄은 보낸 사람(제목), 나머지는 내용', () => {
  assert.deepEqual(popupToEntry(['김대리', '회의 자료 보냈어요', '내일 봬요']), { title: '김대리', body: '회의 자료 보냈어요\n내일 봬요' });
});

test('팝업 글: 앱 이름·시각·버튼 글자·빈 줄은 뺀다', () => {
  const lines = ['카카오톡', '', '김대리', '오후 3:12', '15:12', '회의 자료 보냈어요', '답장', '닫기'];
  assert.deepEqual(popupToEntry(lines, { appName: '카카오톡' }), { title: '김대리', body: '회의 자료 보냈어요' });
});

test('팝업 글: 공백을 하나로, 바로 이어진 같은 줄은 한 번만', () => {
  assert.deepEqual(popupToEntry(['  김대리 ', '안녕\t 하세요', '안녕 하세요']), { title: '김대리', body: '안녕 하세요' });
});

test('팝업 글: 한 줄만 있으면 내용은 비어 있다', () => {
  assert.deepEqual(popupToEntry(['김대리']), { title: '김대리', body: '' });
});

test('팝업 글: 읽은 것이 없으면 null', () => {
  assert.equal(popupToEntry([]), null);
  assert.equal(popupToEntry(undefined), null);
  assert.equal(popupToEntry(['카카오톡', '오전 9:01']), null);
});

test('팝업 글: 제목 200자·내용 2000자까지', () => {
  const e = popupToEntry(['가'.repeat(300), '나'.repeat(3000)]);
  assert.equal(e.title.length, 200);
  assert.equal(e.body.length, 2000);
});

test('앱 이름: 프로세스 이름 → 보관함에 보일 이름', () => {
  assert.equal(popupAppName('KakaoTalk'), '카카오톡');
  assert.equal(popupAppName('Other'), 'Other');
  assert.equal(popupAppName(undefined), '알 수 없는 앱');
});

test('같은 알림: 같은 앱·제목·내용을 짧은 시간 안에 다시 넣지 않는다', () => {
  const now = 1_000_000;
  const recent = [{ app: '카카오톡', title: '김대리', body: '안녕', at: now - 1000 }];
  assert.equal(isRepeat(recent, { app: '카카오톡', title: '김대리', body: '안녕' }, now), true);
  assert.equal(isRepeat(recent, { app: '카카오톡', title: '김대리', body: '다른 글' }, now), false);
  assert.equal(isRepeat(recent, { app: '카카오톡', title: '박과장', body: '안녕' }, now), false);
  assert.equal(isRepeat(recent, { app: '카카오톡', title: '김대리', body: '안녕' }, now + 3 * 60 * 1000), false);
});
