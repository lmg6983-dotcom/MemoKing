import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleText, extractScheduleTitle } from '../app/js/core/schedule-parse.js';

const NOW = new Date(2026, 9, 30, 9, 0); // 2026년 10월 30일 09:00

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('1. 단일 날짜: 날짜 하나가 인식되면 해당 날짜에 일정을 생성한다', () => {
  const r = parseScheduleText('1월 1일 영양제 먹는 날', null, NOW);
  assert.equal(r.title, '영양제 먹는 날');
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].type, 'single');
  assert.equal(ymd(r.schedules[0].start), '2027-01-01');
  assert.equal(r.schedules[0].allDay, true);
  assert.equal(r.emptyTitle, false);
});

test('2. 서로 떨어진 복수 날짜: 독립적인 날짜가 여러 개 인식되면 각 날짜에 동일한 제목의 일정을 생성한다', () => {
  const r = parseScheduleText('1월 1일 그리고 1월 3일 영양제 먹는 날', null, NOW);
  assert.equal(r.title, '영양제 먹는 날');
  assert.equal(r.schedules.length, 2);
  assert.equal(r.schedules[0].type, 'single');
  assert.equal(ymd(r.schedules[0].start), '2027-01-01');
  assert.equal(r.schedules[1].type, 'single');
  assert.equal(ymd(r.schedules[1].start), '2027-01-03');
  assert.equal(r.emptyTitle, false);
});

test('3. 날짜 범위: 시작일과 종료일이 범위 표현으로 연결되어 있으면 기간 일정으로 해석한다 (~)', () => {
  const r = parseScheduleText('1월 1일 ~ 1월 3일 영양제 먹는 날', null, NOW);
  assert.equal(r.title, '영양제 먹는 날');
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].type, 'range');
  assert.equal(ymd(r.schedules[0].start), '2027-01-01');
  assert.equal(ymd(r.schedules[0].end), '2027-01-03');
  assert.equal(r.schedules[0].allDay, true);
  assert.equal(r.emptyTitle, false);
});

test('3-1. 날짜 범위: 부터...까지 표현도 기간 일정으로 해석한다', () => {
  const r = parseScheduleText('1월 1일부터 1월 3일까지 영양제 먹는 날', null, NOW);
  assert.equal(r.title, '영양제 먹는 날');
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].type, 'range');
  assert.equal(ymd(r.schedules[0].start), '2027-01-01');
  assert.equal(ymd(r.schedules[0].end), '2027-01-03');
  assert.equal(r.schedules[0].allDay, true);
});

test('4. 본문 단어 보존: 날짜와 무관한 본문 단어("날" 등)를 제거하지 않는다', () => {
  const r = parseScheduleText('1월 1일 영양제 먹는 날', null, NOW);
  assert.equal(r.title, '영양제 먹는 날');
});

test('5. 날짜만 있고 제목이 비어 있는 경우 emptyTitle: true', () => {
  const r = parseScheduleText('1월 1일', null, NOW);
  assert.equal(r.title, '');
  assert.equal(r.emptyTitle, true);
});

test('6. 날짜가 인식되지 않으면 캘린더에서 선택한 날짜(defaultDay) 사용', () => {
  const defaultDay = new Date(2026, 10, 5); // 11월 5일
  const r = parseScheduleText('팀 회의', defaultDay, NOW);
  assert.equal(r.title, '팀 회의');
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].type, 'single');
  assert.equal(ymd(r.schedules[0].start), '2026-11-05');
  assert.equal(r.emptyTitle, false);
  assert.equal(r.needsDateChoice, false);
});

test('7. 날짜도 인식되지 않고 캘린더 선택 날짜도 없으면 needsDateChoice: true', () => {
  const r = parseScheduleText('팀 회의', null, NOW);
  assert.equal(r.needsDateChoice, true);
});

test('8. 과거 날짜 인식 및 일정 생성 허용', () => {
  const r = parseScheduleText('2025-05-01 옛날 회의', null, NOW);
  assert.equal(r.title, '옛날 회의');
  assert.equal(r.schedules.length, 1);
  assert.equal(ymd(r.schedules[0].start), '2025-05-01');
});

test('9. 같은 날짜 중복 인식 시 정규화(중복 제거)', () => {
  const r = parseScheduleText('1월 1일 그리고 1월 1일 영양제 먹기', null, NOW);
  assert.equal(r.title, '영양제 먹기');
  assert.equal(r.schedules.length, 1);
  assert.equal(ymd(r.schedules[0].start), '2027-01-01');
});

