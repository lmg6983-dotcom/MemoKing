import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupToEntry, popupAppName, isRepeat, findRepeat, betterReading, similarity, kakaoEntry, correctTitle, knownNames, splitTitle } from '../app/js/core/popup-notify.js';

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

test('같은 알림을 두 길로 읽어 글자가 몇 개 틀려도 한 번만 (글자 인식 오타 · 다시 그려진 창)', () => {
  const now = Date.now();
  // 같은 창: 글 그대로 읽은 것 → 몇 초 뒤 글자 인식으로 한두 글자 틀리게
  const recent = [{ app: '카카오톡', hwnd: 7, title: '박지민', body: '혹시 오늘 저녁도 어제와 같아도 괜찮겠니', via: 'uia', at: now - 3000 }];
  assert.ok(findRepeat(recent, { app: '카카오톡', hwnd: 7, title: '박지민', body: '흑시 오늘 저녁도 어제와 같아도 괜찮겠나' }, now));
  // 창이 새로 떠도(다른 hwnd) 2분 안에 제목 · 내용이 거의 같으면
  assert.ok(findRepeat(recent, { app: '카카오톡', hwnd: 9, title: '박지민', body: '혹시 오늘 저녁도 어제와 같아도 괜잖겠니' }, now));
  // 같은 사람의 다른 메시지는 새 알림
  assert.equal(findRepeat(recent, { app: '카카오톡', hwnd: 9, title: '박지민', body: '내일 회의 10시로 바뀌었어요' }, now), null);
  assert.equal(findRepeat(recent, { app: '카카오톡', hwnd: 7, title: '박지민', body: '사진을 보냈습니다' }, now), null);
  assert.ok(similarity('괜찮겠니', '괜찮겠니') === 1 && similarity('김대리', '김대리 (영업팀)') < 0.8 && similarity('김대리', '김대리 (영업팀)', { contain: true }) === 1);
});

test('같은 알림을 다시 읽었을 때: 앞의 것이 글자 인식이고 이번이 글 그대로면 이번 것으로 바꾼다', () => {
  assert.equal(betterReading({ via: 'ocr' }, { via: 'uia' }), true);
  assert.equal(betterReading({ via: 'uia' }, { via: 'ocr' }), false);
  assert.equal(betterReading({ via: 'ocr' }, { via: 'ocr' }), false);
  assert.equal(betterReading({ via: 'msaa' }, { via: 'uia' }), false);
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

test('카카오톡: 프로필 사진 윗변을 알면 그 위는 채팅방, 아래 첫 줄이 보낸 사람 (1:1 이면 보낸 사람만, 단체방이면 채팅방도)', () => {
  const one = [box('우리 여보', 14, 8, 11), box('우리 여보', 64, 32, 13), box('혹시 오늘 저녁도 괜찮겠니', 64, 54, 12), box('메시지 입력', 20, 104, 12)];
  assert.deepEqual(kakaoEntry(one, { width: 330, height: 140, appName: '카카오톡', profileTop: 30 }), { title: '우리 여보', body: '혹시 오늘 저녁도 괜찮겠니' });
  // 작은 글씨를 한 글자 잘못 읽어도 같은 이름 (1:1)
  const typo = [box('우리 여부', 14, 8, 11), ...one.slice(1)];
  assert.equal(kakaoEntry(typo, { width: 330, height: 140, appName: '카카오톡', profileTop: 30 }).title, '우리 여보');
  const group = [box('회사 동기방 ×', 14, 8, 11), box('김대리', 64, 32, 13), box('회의 자료 보냈어요', 64, 54, 12)];
  assert.deepEqual(kakaoEntry(group, { width: 330, height: 140, appName: '카카오톡', profileTop: 30 }), { title: '김대리 (회사 동기방)', body: '회의 자료 보냈어요' });
  // 채팅방 이름 끝의 짧은 영문 낱말은 남긴다 (단추 기호만 뗀다)
  const latin = [box('Team AB', 14, 8, 11), ...group.slice(1)];
  assert.equal(kakaoEntry(latin, { width: 330, height: 140, appName: '카카오톡', profileTop: 30 }).title, '김대리 (Team AB)');
  const xBtn = [box('우리 가족 x', 14, 8, 11), ...group.slice(1)];
  assert.equal(kakaoEntry(xBtn, { width: 330, height: 140, appName: '카카오톡', profileTop: 30 }).title, '김대리 (우리 가족)');
});

test('이미 받은 이름으로 맞추기: 처음 보는 이름이 한 글자만 다르면 받은 이름으로', () => {
  const known = knownNames(['김대리 (회사 동기방)', '박과장 (회사 동기방)', '우리 여보']);
  assert.equal(correctTitle('김대리 (회사 등기방)', known), '김대리 (회사 동기방)');
  assert.equal(correctTitle('김대리 (회사 동기방', known), '김대리 (회사 동기방'); // 괄호가 깨지면 그대로
  assert.equal(correctTitle('우리 여부', known), '우리 여보');
  // 두 글자 이름 · 두 글자 넘게 다른 이름 · 처음 보는 단체방은 그대로
  assert.equal(correctTitle('김대 (회사 동기방)', knownNames(['김대리', '김대'].slice(0, 1))), '김대 (회사 동기방)');
  assert.equal(correctTitle('이부장 (볼링 동호회)', known), '이부장 (볼링 동호회)');
  assert.deepEqual(splitTitle('김대리 (회사 동기방)'), { sender: '김대리', room: '회사 동기방' });
});

test('이미 받은 이름으로 맞추기: 먼저 잘못 읽은 이름이 맞는 이름을 덮지 않고, 훨씬 자주 온 이름이 이긴다', () => {
  // 잘못 읽은 이름이 한 번 들어간 뒤 맞게 읽힌 이름은 그대로 (이미 받은 이름 = 둘 다)
  const once = knownNames(['김대리 (회사 등기방)', '김대리 (회사 동기방)']);
  assert.equal(correctTitle('김대리 (회사 동기방)', once), '김대리 (회사 동기방)');
  // 맞는 이름이 훨씬 자주 왔으면 가끔 잘못 읽은 이름은 그쪽으로
  const many = knownNames(['a (회사 동기방)', 'b (회사 동기방)', 'c (회사 동기방)', 'd (회사 동기방)', 'e (회사 등기방)']);
  assert.equal(correctTitle('김대리 (회사 등기방)', many), '김대리 (회사 동기방)');
});
