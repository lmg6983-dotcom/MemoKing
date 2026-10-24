import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tagQuestion, rankedTags, withLaya } from '../app/js/core/laya-tags.js';
import { createLayaService } from '../desktop/ai/laya-service.js';

const memo = (id, title, tags, updated = '2026-10-01') => ({ id, updated, body: `# ${title}\n\n${tags.map((t) => `#${t}`).join(' ')}\n` });
const vault = [memo('a', '주간 회의록', ['회의', '업무'], '2026-10-03'), memo('b', '마트', ['장보기']), memo('c', '디자인 리뷰', ['회의'])];

test('AI 태그 질문: 기존 태그 중에서, 보기는 태그 이름만', () => {
  const q = tagQuestion('# 스탠드업\n\n어제 한 일 공유, 배포 일정 확인', vault, { excludeId: 'x' });
  assert.equal(q.questions.tag.type, 'choice');
  assert.deepEqual(new Set(q.candidates), new Set(['회의', '업무', '장보기']));
  assert.deepEqual(q.questions.tag.criteria, q.candidates);
  assert.ok(!q.state.includes('#'));
});

test('AI 태그 질문: 짧은 메모 · 기존 태그가 없는 폴더 · 이미 단 태그는 묻지 않음', () => {
  assert.equal(tagQuestion('# 짧음', vault), null);
  assert.equal(tagQuestion('# 스탠드업\n\n어제 한 일 공유, 배포 일정 확인', []), null);
  const q = tagQuestion('# 스탠드업\n\n어제 한 일 공유, 배포 일정 확인 #회의', vault);
  assert.ok(!q.candidates.includes('회의'));
});

test('Laya 답 → 확률 순 · 추천 칩 순서 (Laya 가 고른 기존 태그를 앞에, 새 태그 추천은 뒤로)', () => {
  const ranked = rankedTags({ answers: { tag: { choice: '회의', probabilities: { 업무: 0.2, 회의: 0.7, 장보기: 0.1 } } } });
  assert.deepEqual(ranked.map((r) => r.name), ['회의', '업무', '장보기']);
  const list = [{ name: '배포', existing: false }, { name: '업무', existing: true }];
  assert.deepEqual(withLaya(list, ranked).map((t) => t.name), ['회의', '업무', '배포']);
  assert.equal(withLaya(list, []), list);
});

test('AI 태그 모델 받기: 파일마다 SHA-256 이 맞아야 넣고, 맞지 않으면 아무것도 남기지 않음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-'));
  const data = { 'encoder.onnx': Buffer.from('enc'), 'head.onnx': Buffer.from('head') };
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const model = { base: 'https://x/', files: Object.entries(data).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })) };
  const statuses = [];
  const svc = createLayaService({ dir, model, onStatus: (s) => statuses.push(s.state), fetch: async (url) => new Response(data[url.slice(10)]) });
  assert.equal(svc.status().state, 'missing');
  assert.equal((await svc.download()).state, 'ready');
  assert.ok(statuses.includes('downloading'));
  assert.equal(svc.status().size, 7);
  assert.equal((await svc.remove()).state, 'missing');

  const bad = createLayaService({ dir, model, onStatus: () => {}, fetch: async () => new Response('엉뚱한 것') });
  const st = await bad.download();
  assert.equal(st.state, 'missing');
  assert.match(st.error, /맞지 않아요/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const offline = createLayaService({ dir, model, onStatus: () => {}, fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.match((await offline.download()).error, /인터넷에 연결하지 못했어요/);
  assert.deepEqual(await offline.rank('# 스탠드업\n\n어제 한 일 공유, 배포 일정 확인', vault), []); // 모델이 없으면 묻지 않음
});
