import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDates, findAllDates } from '../app/js/core/date-detect.js';

// 2026-10-10 (토) 10:00
const NOW = new Date(2026, 9, 10, 10, 0);
const one = (text, now = NOW) => {
  const r = findDates(text, now);
  return r.length ? { text: r[0].text, at: fmt(r[0].at), hasTime: r[0].hasTime } : null;
};
const fmt = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

test('오늘·내일·모레 + 시각', () => {
  assert.deepEqual(one('내일 오후 3시 치과'), { text: '내일 오후 3시', at: '2026-10-11 15:00', hasTime: true });
  assert.deepEqual(one('모레 10시 반에 회의'), { text: '모레 10시 반', at: '2026-10-12 10:30', hasTime: true });
  assert.deepEqual(one('오늘 저녁 7시 약속'), { text: '오늘 저녁 7시', at: '2026-10-10 19:00', hasTime: true });
  assert.equal(one('내일까지 보고서')?.at, '2026-10-11 9:00');
  assert.equal(one('오늘 할 일'), null, '"오늘" 만은 알림 시각이 없다');
  assert.equal(one('오늘 아침 8시'), null, '이미 지난 시각');
});

test('날짜 표기', () => {
  assert.deepEqual(one('10월 12일 14:30 발표'), { text: '10월 12일 14:30', at: '2026-10-12 14:30', hasTime: true });
  assert.equal(one('2026-11-03 마감').at, '2026-11-3 9:00');
  assert.equal(one('2026.11.3(화) 오전 11시').at, '2026-11-3 11:00');
  assert.equal(one('1월 5일 신년회').at, '2027-1-5 9:00', '지난 달이면 내년');
  assert.equal(one('10/20(화) 3시').at, '2026-10-20 15:00');
  assert.equal(one('밀가루 1/2 컵'), null, '분수는 날짜가 아님');
  assert.equal(one('2월 30일'), null, '없는 날');
});

test('요일', () => {
  assert.equal(one('다음 주 화요일 회의').at, '2026-10-13 9:00');
  assert.equal(one('이번 주 일요일 오후 2시').at, '2026-10-11 14:00');
  assert.equal(one('다다음주 월요일').at, '2026-10-19 9:00');
  assert.equal(one('금요일까지 제출').at, '2026-10-16 9:00');
  assert.equal(one('토요일 오후 5시').at, '2026-10-10 17:00', '오늘이 토요일이면 오늘');
  assert.equal(one('토요일 9시').at, '2026-10-17 9:00', '오늘 그 시각이 지났으면 다음 주');
  assert.equal(one('지난 금요일에 만난'), null);
  assert.equal(one('지난주 화요일'), null);
});

test('상대 표현', () => {
  assert.deepEqual(one('30분 뒤 전화'), { text: '30분 뒤', at: '2026-10-10 10:30', hasTime: true });
  assert.equal(one('2시간 후').at, '2026-10-10 12:00');
  assert.equal(one('3일 뒤').at, '2026-10-13 9:00');
  assert.equal(one('2주 후 오후 4시').at, '2026-10-24 16:00');
  assert.equal(one('다음 달 3일').at, '2026-11-3 9:00');
});

test('시각만', () => {
  assert.equal(one('3시 회의').at, '2026-10-10 15:00', '오전·오후 없는 1~6시는 오후');
  assert.equal(one('오후 1:30 점심').at, '2026-10-10 13:30');
  assert.equal(one('정오에 만나').at, '2026-10-10 12:00');
  assert.equal(one('9시 출근'), null, '지난 시각');
  assert.equal(one('3시간 동안'), null);
  assert.equal(one('시험 시작 시간'), null);
  assert.equal(one('기록 12:30'), null, '오전·오후 없는 숫자 시각만은 기록일 때가 많다');
  assert.equal(one('밤 12시').at, '2026-10-11 0:00');
});

test('한 줄에 여러 개, 겹치지 않게', () => {
  const r = findDates('내일 3시 미팅, 금요일 오전 10시 마감', NOW);
  assert.deepEqual(r.map((x) => x.text), ['내일 3시', '금요일 오전 10시']);
  assert.equal(r[0].from, 0);
  assert.equal('내일 3시 미팅, 금요일 오전 10시 마감'.slice(r[1].from, r[1].to), '금요일 오전 10시');
});

test('영어는 chrono 결과를 받아 합친다', () => {
  const fake = { parse: () => [{ index: 0, text: 'tomorrow at 5pm', start: { knownValues: { hour: 17 }, date: () => new Date(2026, 9, 11, 17, 0) } }] };
  const r = findAllDates('tomorrow at 5pm call', { chrono: fake, now: NOW });
  assert.equal(r.length, 1);
  assert.equal(fmt(r[0].at), '2026-10-11 17:00');
});
