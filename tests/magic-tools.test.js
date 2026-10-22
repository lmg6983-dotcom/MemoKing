import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, format } from '../app/vendor/mathjs.js';
import { calcInput, calcOutput, siteUrl, siteLink, sitesInOrder, WEB_ENGINES, AI_SITES, looksLikeQuestion } from '../app/js/core/magic-tools.js';

const calc = (text) => {
  const expr = calcInput(text);
  return expr && calcOutput(evaluate(expr), format);
};

test('매직키 계산기: 식은 계산 (천 단위 쉼표, ×÷, %, 단위 바꾸기)', () => {
  assert.deepEqual(calc('1,200 × 3'), { value: '3,600', plain: '3600' });
  assert.deepEqual(calc('= 10 ÷ 4'), { value: '2.5', plain: '2.5' });
  assert.equal(calc('15% * 80000').plain, '12000');
  assert.equal(calc('0.1+0.2').plain, '0.3');
  assert.equal(calc('5 inch to cm').plain, '12.7 cm');
  assert.equal(calc('sqrt(16)').plain, '4');
  assert.equal(calc('1234567 * 10').value, '12,345,670');
});

test('매직키 계산기: 숫자만 · 날짜 · 전화번호 · 보통 글은 계산하지 않음', () => {
  for (const t of ['42', '-5', '2026-10-22', '010-1234-5678', '10/22/2026', '1.2.3', '회의 3-4시', '보고서 2부', '', '1+1\n2']) assert.equal(calcInput(t), null, t);
  assert.throws(() => evaluate(calcInput('abc+1'))); // 모르는 낱말은 math.js 가 막고 매직키는 결과 줄을 안 보인다
  assert.equal(calcOutput(evaluate('1e400*10'), format), null); // 무한대
});

test('매직키 계산기: 식 안에서 math.js 의 위험한 기능은 막힘', () => {
  assert.throws(() => evaluate('import({ x: 1 })'), /disabled/);
  assert.throws(() => evaluate('createUnit("foo")'), /disabled/);
  assert.throws(() => evaluate('evaluate("1+1")'), /disabled/);
});

test('매직키 웹 검색 · AI: 주소 만들기, 고른 사이트가 맨 앞', () => {
  assert.equal(siteLink(WEB_ENGINES, 'naver', ' 날씨 서울 ').url, 'https://search.naver.com/search.naver?query=%EB%82%A0%EC%94%A8%20%EC%84%9C%EC%9A%B8');
  assert.equal(siteLink(AI_SITES, 'chatgpt', 'a&b').url, 'https://chatgpt.com/?q=a%26b');
  assert.equal(siteLink(AI_SITES, 'claude', '안녕').url, 'https://claude.ai/new?q=%EC%95%88%EB%85%95');
  assert.equal(siteLink(AI_SITES, 'gemini', '안녕').paste, true); // 주소로 못 넘기니 복사해 두고 연다
  assert.equal(siteLink(WEB_ENGINES, 'nope', 'x'), null);
  assert.equal(siteLink(WEB_ENGINES, 'google', '   '), null);
  assert.deepEqual(sitesInOrder(AI_SITES, 'claude').map((s) => s.id), ['claude', 'chatgpt', 'gemini', 'perplexity']);
  assert.equal(sitesInOrder(WEB_ENGINES, 'nope')[0].id, 'naver');
});

test('매직키 사이트 열기: 주소처럼 보일 때만 (파일 이름 · 숫자는 아님)', () => {
  assert.equal(siteUrl('naver.com'), 'https://naver.com');
  assert.equal(siteUrl('www.youtube.com/watch?v=1'), 'https://www.youtube.com/watch?v=1');
  assert.equal(siteUrl('https://example.org/a b'), null);
  assert.equal(siteUrl('http://localhost.test/x'), 'http://localhost.test/x');
  for (const t of ['report.pdf', 'memo.md', '1.5', 'naver com', '회의.com 메모']) assert.equal(siteUrl(t), null, t);
});

test('묻는 글이면 AI 에게 묻기 줄을 위로: "?" · 묻는 말로 시작 · 부탁하는 끝말', () => {
  for (const q of ['환율 뭐야', '이 메일 정리해줘', '회의록 요약해 주세요', '파이썬 리스트 정렬은?', '왜 하늘은 파란가', 'how to center a div', '내일 비 올까', '이거 맞는지']) {
    assert.ok(looksLikeQuestion(q), q);
  }
  for (const q of ['내일 3시 회의', '견적서', '1,200 × 3', 'naver.com', '장보기: 우유, 계란', '', '첫 줄\n둘째 줄?']) {
    assert.ok(!looksLikeQuestion(q), q);
  }
});
