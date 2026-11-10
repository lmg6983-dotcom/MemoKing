// AI 검색 정답 묶음 — "이 질문에는 이 메모가 맨 위에 나와야 한다". 찾기(rag.js retrieve)를 고칠 때 좋아졌는지 나빠졌는지 숫자로 본다.
//   모델 없이 (질문을 넓힌 낱말 없이) 낱말 · 두 글자 조각 · 비슷한 말 묶음만으로 찾는 바닥 실력이다. 맞히는 비율이 MIN 아래로 떨어지면 실패
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMemo, retrieve } from '../app/js/core/rag.js';

const MEMOS = {
  launch: '# 주간 회의\n\n출시일은 11월 3일로 정했어요. 안드로이드 버전은 한 주 뒤에 내요.\n- 디자인 시안 확정\n- 릴리스 노트 초안은 민지가 써요',
  dentist: '# 치과 예약\n\n다음 주 화요일 오후 3시 스케일링. 보험증 챙기기. 강남역 3번 출구 서울밝은치과',
  wifi: '# 사무실 와이파이\n\n이름 MEMOKING-5G, 비밀번호는 총무팀 김과장에게 물어보기. 손님용은 guest 로 접속',
  quote: '# KT 견적서\n\n담당자 박서준 대리. 견적서는 금요일까지 보내기로 했어요. 단가는 개당 12,000원, 수량 500개',
  patent: '# 특허 출원 메모\n\n관리번호 P2026-1170-KR01. 발명자는 홍길동, 김철수. 우선심사 신청은 다음 달에 해요',
  recipe: '# 김치찌개\n\n돼지고기 목살 300g, 묵은지 반 포기, 두부 한 모. 쌀뜨물로 끓이면 국물이 진해요',
  trip: '# 제주 여행\n\n11월 20일 김포에서 오전 8시 비행기. 렌터카는 공항에서 받고 숙소는 애월 쪽 펜션',
  server: '# 서버 장애 기록\n\n새벽 2시에 디스크가 가득 차서 배포가 멈췄어요. 로그 정리 스크립트를 크론에 넣기로 했어요',
  book: '# 읽을 책\n\n- 사피엔스\n- 데미안\n- 클린 코드는 회사 책장에 있어요',
  gym: '# 운동 계획\n\n월수금 저녁 8시 헬스장. 스쿼트 60kg 다섯 세트, 달리기 3km',
  rent: '# 월세\n\n매달 5일에 집주인 계좌로 65만원 이체. 관리비는 따로 8만원',
  gift: '# 어머니 생신\n\n음력 9월 12일. 선물은 안마기, 케이크는 동네 빵집에서 예약',
  car: '# 자동차 정비\n\n엔진오일은 1만 km 마다 갈아요. 지난번에는 5월에 갈았고 타이어 공기압도 봤어요',
  idea: '# 앱 아이디어\n\n메모에 쓴 날짜를 알아서 일정으로 만들어 주는 기능. 음성 녹음을 글로 바꾸는 기능',
};
const chunks = Object.entries(MEMOS).flatMap(([id, body]) => chunkMemo(body).map((text) => ({ id, title: body.split('\n')[0].replace(/^# /, ''), text })));

// [질문, 나와야 할 메모]
const ASKS = [
  ['출시일이 언제야?', 'launch'], ['릴리스 노트 누가 써?', 'launch'], ['치과 몇 시였지', 'dentist'], ['와이파이 비밀번호', 'wifi'],
  ['견적서 언제까지 보내기로 했지', 'quote'], ['KT 담당자 이름', 'quote'], ['단가가 얼마였어?', 'quote'], ['특허 관리번호 알려줘', 'patent'],
  ['발명자가 누구야', 'patent'], ['김치찌개에 뭐 넣어?', 'recipe'], ['제주도 비행기 시간', 'trip'], ['숙소 어디로 잡았지', 'trip'],
  ['서버 왜 멈췄어', 'server'], ['디스크 가득 찼던 날', 'server'], ['클린 코드 어디 있어', 'book'], ['헬스장 가는 요일', 'gym'],
  ['월세 얼마 보내야 해', 'rent'], ['관리비는?', 'rent'], ['어머니 생신 선물 뭐로 하기로 했지', 'gift'], ['엔진오일 언제 갈았더라', 'car'],
  ['타이어 공기압', 'car'], ['음성을 글로 바꾸는 아이디어', 'idea'], ['손님용 와이파이 접속', 'wifi'], ['우선심사는 언제 신청해', 'patent'],  
  // 말을 바꿔 물은 것 (메모에 그 낱말이 없다) — 비슷한 말 묶음(rag.js SYNONYMS)에 있는 말만 찾고, 나머지(이 닦으러 · 저녁 메뉴)는 모델이 질문을 넓혀 줘야 한다
  ['앱 언제 내놓기로 했지', 'launch'], ['이 닦으러 가는 날', 'dentist'], ['인터넷 암호', 'wifi'], ['가격 얼마에 주기로 했어', 'quote'],
  ['저녁 메뉴 재료', 'recipe'], ['휴가 항공편', 'trip'], ['집세 보내는 날', 'rent'], ['차 수리 기록', 'car'],
];
const MIN = 0.9; // 지금 실력보다 조금 아래 — 좋아지면 올린다

test('AI 검색 정답 묶음: 정답 메모가 맨 위에', () => {
  const missed = ASKS.filter(([q, want]) => retrieve(q, chunks, { limit: 1 })[0]?.id !== want).map(([q, want]) => `${q} → ${want}`);
  const rate = 1 - missed.length / ASKS.length;
  console.log(`AI 검색 정답 묶음: ${ASKS.length - missed.length}/${ASKS.length} (${Math.round(rate * 100)}%)${missed.length ? ` · 놓친 것: ${missed.join(' | ')}` : ''}`);
  assert.ok(rate >= MIN, `맞힌 비율 ${rate.toFixed(2)} < ${MIN} — 놓친 것: ${missed.join(' | ')}`);
});
