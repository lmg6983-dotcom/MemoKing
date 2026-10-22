import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupToEntry, popupAppName, isRepeat, kakaoEntry } from '../app/js/core/popup-notify.js';

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

test('같은 알림 창을 방금 읽었으면 바로 읽은 글과 글자 인식 결과가 조금 달라도 한 번만', () => {
  const now = Date.now();
  const recent = [{ app: '카카오톡', hwnd: 7, title: '김대리', body: '회의 자료 보냈어요', at: now - 2000 }];
  // 글자 인식이 채팅방 이름까지 읽거나 띄어쓰기가 다르게
  assert.equal(isRepeat(recent, { app: '카카오톡', hwnd: 7, title: '김대리 (영업팀)', body: '회의 자료 보냈어요' }, now), true);
  assert.equal(isRepeat(recent, { app: '카카오톡', hwnd: 7, title: '김대리', body: '회의자료 보냈어요.' }, now), true);
  // 다른 창 · 시간이 지난 뒤 · 다른 글이면 새 알림
  assert.equal(isRepeat(recent, { app: '카카오톡', hwnd: 8, title: '김대리 (영업팀)', body: '회의 자료 보냈어요' }, now), false);
  assert.equal(isRepeat(recent, { app: '카카오톡', hwnd: 7, title: '김대리 (영업팀)', body: '회의 자료 보냈어요' }, now + 20_000), false);
  assert.equal(isRepeat(recent, { app: '카카오톡', hwnd: 7, title: '김대리', body: '내일 봬요' }, now), false);
});

// 카카오톡 알림 창 (폭 340 · 높이 110, 100% 배율 px)
const SIZE = { width: 340, height: 110, appName: '카카오톡' };
const box = (text, x, y, h = 14) => ({ text, x, y, w: text.length * 12, h });

test('카카오톡: 단톡방 = 방 이름 · 보낸 사람 · 메시지', () => {
  const boxes = [box('가족방', 70, 12), box('엄마', 70, 34), box('저녁 7시에 와', 70, 62), box('0', 290, 10), box('x', 316, 10)];
  assert.deepEqual(kakaoEntry(boxes, SIZE), { title: '엄마 (가족방)', body: '저녁 7시에 와' });
});

test('카카오톡: 1:1 대화 — 방 이름과 보낸 사람이 같으면 한 번만, 여러 줄 메시지', () => {
  const boxes = [box('김대리', 70, 12), box('김대리', 70, 34), box('회의 자료 보냈어요', 70, 62), box('확인 부탁드려요', 70, 80)];
  assert.deepEqual(kakaoEntry(boxes, SIZE), { title: '김대리', body: '회의 자료 보냈어요\n확인 부탁드려요' });
});

test('카카오톡: 윗줄 하나 + 메시지 줄 (둘째 줄이 메시지 자리)', () => {
  assert.deepEqual(kakaoEntry([box('김대리', 70, 14), box('넵', 70, 62)], SIZE), { title: '김대리', body: '넵' });
});

test('카카오톡: 이모티콘·사진 — 방 이름과 보낸 사람만, 내용은 비어 있다', () => {
  assert.deepEqual(kakaoEntry([box('가족방', 70, 12), box('아빠', 70, 34)], SIZE), { title: '아빠 (가족방)', body: '' });
});

test('카카오톡: 자모만의 메시지는 남기고, 기호·버튼·잘못 읽은 한 글자는 뺀다', () => {
  const boxes = [box('김대리', 70, 12), box('—', 70, 40), box('ㅋㅋㅋ', 70, 62), box('답장', 250, 90), box('o', 20, 50), box('오후 3:12', 70, 96)];
  assert.deepEqual(kakaoEntry(boxes, SIZE), { title: '김대리', body: 'ㅋㅋㅋ' });
});

test('카카오톡: 오른쪽 위 버튼 자리의 글은 빼고, 같은 높이의 조각은 왼쪽부터 한 줄로', () => {
  const boxes = [box('프로젝트', 70, 12), box('알림', 300, 12), box('박과장', 70, 34), box('내일', 70, 62, 15), box('10시요', 120, 63, 14)];
  assert.deepEqual(kakaoEntry(boxes, SIZE), { title: '박과장 (프로젝트)', body: '내일 10시요' });
});

test('카카오톡: 읽은 것이 없으면 null', () => {
  assert.equal(kakaoEntry([], SIZE), null);
  assert.equal(kakaoEntry([box('0', 290, 10), box('카카오톡', 70, 12)], SIZE), null);
  assert.equal(kakaoEntry(undefined), null);
});

test('카카오톡: 맨 위 채팅방 줄을 지우고 읽었으면(roomCut) 첫 줄이 보낸 사람, 나머지가 메시지', () => {
  const boxes = [box('우리 여보', 64, 32, 13), box('혹시 오늘 저녁도 괜찮겠니', 64, 54, 12), box('메시지 입력', 20, 104, 12)];
  assert.deepEqual(kakaoEntry(boxes, { width: 330, height: 140, appName: '카카오톡', roomCut: true }), { title: '우리 여보', body: '혹시 오늘 저녁도 괜찮겠니' });
  // 지우지 못했으면(프로필을 못 찾음) 예전처럼 맨 위 줄을 채팅방으로
  assert.equal(kakaoEntry(boxes, { width: 330, height: 140, appName: '카카오톡' }).title, '혹시 오늘 저녁도 괜찮겠니 (우리 여보)');
});
