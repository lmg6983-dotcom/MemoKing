// 매직키 날짜 계산 (app/js/core/date-calc.js) — 오늘을 2026-10-22 (목) 오후 2:10 으로 두고
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateCalc, parseDay, parseDuration, parseClock } from '../app/js/core/date-calc.js';

const now = new Date(2026, 9, 22, 14, 10);
const plain = (q) => dateCalc(q, now)?.plain ?? null;
const value = (q) => dateCalc(q, now)?.value ?? null;
const detail = (q) => dateCalc(q, now)?.detail ?? '';

test('오늘에서 뒤 · 전 (해 · 달은 달력으로, 고유어 · 반 · 소수 · 띄어쓰기 없이도)', () => {
  assert.equal(plain('3주 뒤'), '2026-11-12');
  assert.equal(plain('100일 후'), '2027-01-30');
  assert.equal(plain('2달 전'), '2026-08-22');
  assert.equal(plain('3개월 뒤'), '2027-01-22');
  assert.equal(plain('1년 반 뒤'), '2028-04-22');
  assert.equal(plain('1.5년 뒤'), '2028-04-22');
  assert.equal(plain('반년 뒤'), '2027-04-22');
  assert.equal(plain('열흘 뒤'), '2026-11-01');
  assert.equal(plain('한 달 뒤'), '2026-11-22');
  assert.equal(plain('두 달 후'), '2026-12-22');
  assert.equal(plain('일주일 후'), '2026-10-29');
  assert.equal(plain('3일전'), '2026-10-19');
  assert.equal(plain('3일후'), '2026-10-25');
  assert.equal(plain('오늘로부터 100일 뒤'), '2027-01-30');
  assert.equal(plain('30일 뒤 날짜'), '2026-11-21');
  assert.equal(value('3주 뒤'), '2026년 11월 12일 (목)');
  assert.match(detail('3주 뒤'), /오늘부터 3주 뒤, 21일 뒤/);
  assert.doesNotMatch(detail('100일 후'), /100일 뒤, 100일 뒤/, '같은 말을 두 번 쓰지 않음');
});

test('며칠째 · D-day 세기 (그날을 1일째로)', () => {
  assert.equal(plain('100일째'), '2027-01-29');
  assert.equal(plain('오늘부터 100일'), '2027-01-29', '기념일 세는 법: 오늘이 1일째');
  assert.match(detail('오늘부터 100일'), /100일 뒤는 2027년 1월 30일/);
  assert.equal(plain('3월 1일부터 100일째'), '2026-06-08');
  assert.equal(plain('3월 1일부터 100일'), '2026-06-08');
  assert.equal(plain('D-100'), '2027-01-30');
  assert.equal(plain('d+30'), '2026-11-21');
  assert.match(detail('D-100'), /D-day는 100일 뒤/);
});

test('날짜에서 더하고 빼기 (기호가 든 날짜에 속지 않음, 없는 날은 그 달 말일)', () => {
  assert.equal(plain('2026-03-01 + 100일'), '2026-06-09');
  assert.equal(plain('12/25 - 2주'), '2026-12-11');
  assert.equal(plain('크리스마스로부터 30일 뒤'), '2027-01-24');
  assert.equal(plain('2026-01-31 + 1달'), '2026-02-28');
  assert.match(detail('2026-01-31 + 1달'), /그 달 말일/);
  assert.equal(plain('1월 31일 + 1개월'), '2026-02-28');
  assert.equal(plain('2028-02-29 + 1년'), '2029-02-28');
});

test('남은 날 · 지난 날 (해 없는 날은 다가오는 날, 물음 말이 붙어도)', () => {
  assert.equal(value('12월 25일까지'), '64일 남음');
  assert.equal(plain('12/25까지 며칠'), '64');
  assert.equal(plain('12월 25일까지 며칠 남았어?'), '64');
  assert.equal(plain('2026년 12월 25일까지'), '64');
  assert.match(detail('12월 25일까지'), /9주 1일, D-64/);
  assert.equal(plain('크리스마스까지 몇 주'), '64');
  assert.equal(plain('어린이날까지 며칠이야'), '195', '올해 지났으면 내년');
  assert.equal(plain('내년 어린이날까지'), '195');
  assert.equal(plain('디데이 2027-01-01'), '71');
  assert.equal(plain('D-day 12/25'), '64');
  assert.equal(plain('12/25 디데이'), '64');
  assert.equal(value('금요일까지'), '1일 남음');
  assert.equal(value('2026-03-01부터'), '235일 지남');
  assert.match(detail('2026-03-01부터'), /오늘이 236일째/);
  assert.equal(value('어제부터 며칠'), '1일 지남');
  assert.equal(dateCalc('13월 1일까지', now), null);
  assert.equal(dateCalc('2/30까지', now), null);
});

test('두 날 사이: 날 수 · 주 · 해달날 · 양 끝 포함 · 영업일', () => {
  assert.equal(plain('1월 1일부터 6월 30일까지'), '180');
  assert.equal(plain('2026.1.1 ~ 2026.6.30'), '180');
  assert.match(detail('2026.1.1 ~ 2026.6.30'), /25주 5일, 5개월 29일, 양 끝 포함 181일, 영업일 127일/);
  assert.equal(plain('3월 1일부터 오늘까지 며칠'), '235');
  assert.equal(plain('3월 1일에서 오늘까지'), '235');
  assert.equal(plain('2026-03-01 ~ 오늘'), '235');
  assert.equal(plain('오늘부터 크리스마스까지'), '64');
  assert.equal(plain('11월 1일 ~ 2월 1일'), '92', '끝이 앞서면 다음 해');
});

test('영업일: 토 · 일 · 양력 공휴일을 빼고', () => {
  assert.equal(plain('영업일 10일 뒤'), '2026-11-05');
  assert.equal(plain('평일 5일 후'), '2026-10-29');
  assert.equal(plain('10영업일 뒤'), '2026-11-05');
  assert.equal(plain('2026-03-02부터 10영업일 뒤'), '2026-03-16');
  assert.equal(plain('3월 1일부터 영업일 10일'), '2026-03-13', '3월 1일(삼일절 · 일요일)은 세지 않음');
  assert.equal(plain('2026-12-23부터 영업일 3일 뒤'), '2026-12-29', '24일 · (크리스마스 · 주말 건너뜀) · 28일 · 29일');
  assert.match(detail('영업일 10일 뒤'), /토 · 일 · 양력 공휴일 뺌/);
});

test('요일 · 이름 있는 날 · 날짜만', () => {
  assert.equal(value('12월 25일 무슨 요일'), '2026년 12월 25일 (금)');
  assert.equal(plain('2027-01-01 요일'), '2027-01-01');
  assert.equal(plain('다음 주 금요일'), '2026-10-30');
  assert.equal(plain('지난주 금요일'), '2026-10-16');
  assert.equal(plain('이번 주 토요일'), '2026-10-24');
  assert.equal(plain('2주 뒤 금요일'), '2026-11-06');
  assert.equal(plain('다음 달 말일'), '2026-11-30');
  assert.equal(plain('다음 달 15일'), '2026-11-15');
  assert.equal(plain('이번 달 말일'), '2026-10-31');
  assert.equal(plain('2026년 2월 말일'), '2026-02-28');
  assert.equal(plain('크리스마스 무슨 요일'), '2026-12-25');
  assert.equal(plain('100일 뒤는 무슨 요일이야?'), '2027-01-30');
  assert.equal(plain('2026-12-25'), '2026-12-25');
  assert.equal(plain('26.12.25'), '2026-12-25');
  assert.equal(plain('12월 25일'), '2026-12-25');
  assert.equal(dateCalc('2027-02-29', now), null, '없는 날');
});

test('시각: 지금부터 · 시각 ± · 두 시각 사이 (밤을 넘겨도)', () => {
  assert.equal(value('3시간 뒤'), '오후 5:10');
  assert.equal(plain('90분 후'), '15:40');
  assert.equal(plain('1시간 반 뒤'), '15:40');
  assert.equal(plain('45분 전'), '13:25');
  assert.equal(value('12시간 뒤'), '내일 오전 2:10');
  assert.equal(value('2일 3시간 뒤'), '모레 오후 5:10');
  assert.equal(value('오후 3시 + 2시간'), '오후 5:00');
  assert.equal(value('오후 11시 + 3시간'), '다음 날 오전 2:00');
  assert.equal(plain('15:30 + 45분'), '16:15');
  assert.equal(plain('정오 + 90분'), '13:30');
  assert.equal(value('9:15부터 18:30까지'), '9시간 15분');
  assert.equal(value('14:30 - 9:15'), '5시간 15분');
  assert.equal(value('오후 10시부터 오전 2시까지'), '4시간');
  assert.equal(value('3시부터 5시 반까지'), '2시간 30분');
  assert.match(detail('3시부터 5시 반까지'), /오후 3:00 ~ 오후 5:30/, '오전 · 오후 없는 1~6시는 오후');
});

test('나이 · 오늘', () => {
  assert.equal(value('만 나이 1990-05-03'), '만 36세');
  assert.equal(value('1990년 5월 3일생 나이'), '만 36세');
  assert.equal(value('1990.05.03 만 나이'), '만 36세');
  assert.match(detail('만나이 2000-02-29'), /만|생/);
  assert.equal(value('만나이 2000-02-29'), '만 26세');
  assert.equal(plain('오늘 날짜'), '2026-10-22');
  assert.equal(value('오늘 무슨 요일'), '2026년 10월 22일 (목)');
  assert.equal(value('오늘 몇 주차'), '43주차');
  assert.equal(value('올해 남은 날'), '70일 남음');
});

test('날짜 계산이 아닌 글은 그대로 (메모 · 찾기 · 계산식을 빼앗지 않음)', () => {
  for (const q of ['내일 3시 회의', '3일 뒤 출장 준비', '견적서', '1,200 × 3', '12/25', '오늘', '25일', '금', '회의록 정리해줘', '3시 회의', '설날까지', '', '첫 줄\n3주 뒤']) {
    assert.equal(dateCalc(q, now), null, q);
  }
});

test('조각: 날짜 · 기간 · 시각 읽기', () => {
  assert.equal(parseDay('12월 25일', now, 'past').date.getFullYear(), 2025, '부터: 지나간 날');
  assert.equal(parseDay('12월 25일', now, 'future').date.getFullYear(), 2026);
  assert.equal(parseDay('3월 1일', now, 'future').date.getFullYear(), 2027, '까지: 지났으면 내년');
  assert.equal(parseDay('2월 29일', now, 'future').date.getFullYear(), 2028, '윤년 2월 29일은 다음 윤년');
  assert.deepEqual(parseDuration('1년 2개월 3주 4일'), { y: 1, mo: 2, w: 3, d: 4, h: 0, min: 0, s: 0 });
  assert.deepEqual(parseDuration('2시간 반'), { y: 0, mo: 0, w: 0, d: 0, h: 2, min: 30, s: 0 });
  assert.equal(parseDuration('회의'), null);
  assert.deepEqual(parseClock('오후 3시 30분'), { h: 15, min: 30, ampm: true });
  assert.deepEqual(parseClock('밤 12시'), { h: 12, min: 0, ampm: true });
  assert.equal(parseClock('25:00'), null);
});

test('매직키 "알림 맞춰 저장": 글 속 날짜로 일정 (시각 있으면 10분 전, 날짜만이면 하루 종일 · 그날 9시, 되풀이)', async () => {
  const { findDates, guessTitle } = await import('../app/js/core/date-detect.js');
  const { eventFromDate } = await import('../app/js/core/reminders.js');
  const ev = (q) => {
    const f = findDates(q, now)[0];
    return eventFromDate({ ...f, title: guessTitle(q, f.from, f.to) }, now);
  };
  const a = ev('내일 오후 3시 거래처 전화');
  assert.equal(a.kind, 'at');
  assert.equal(a.title, '거래처 전화');
  assert.deepEqual(a.alerts, [10]);
  assert.equal(new Date(a.at).getHours(), 15);
  const b = ev('12월 25일 선물 사기');
  assert.equal(b.allDay, true);
  assert.equal(b.title, '선물 사기');
  assert.deepEqual(b.alerts, [-540]);
  const c = ev('매주 월요일 10시 주간 회의');
  assert.equal(c.kind, 'repeat');
  assert.deepEqual(c.repeat, { every: 'week', time: '10:00', weekdays: [1] });
  assert.equal(eventFromDate({ at: 'nope' }, now), null);
});
