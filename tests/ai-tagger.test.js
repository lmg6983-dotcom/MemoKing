import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../desktop/vault.js';
import { createAiTagger } from '../desktop/ai/ai-tagger.js';
import { removeTags } from '../app/js/core/tag-suggest.js';
import { extractTags } from '../app/js/core/tags.js';

function setup({ picks = ['회의', '거래처', '출장'], open = new Set() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-aitag-'));
  const vault = new Vault(dir);
  vault.open();
  const asked = [];
  const tasks = { autoTags: async (body) => { asked.push(body); return picks.slice(0, 3 - extractTags(body).length); } };
  const progress = [];
  const tagger = createAiTagger({
    getVault: () => vault, tasks: () => tasks, ready: async () => true, isOpen: (id) => open.has(id), enabled: () => true,
    onProgress: (p) => progress.push(p),
  });
  return { dir, vault, tagger, asked, progress, done: () => {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('AI 태그: 사용자 태그와 합쳐 3개까지, 고친 시각은 그대로, 한 번 본 메모는 다시 묻지 않는다', async () => {
  const t = setup();
  try {
    const id = t.vault.import({ body: '# 거래처 미팅\n\n내일 견적 #업무' });
    const updated = t.vault.get(id).updated;
    await t.tagger.add([id]);
    const m = t.vault.get(id);
    assert.deepEqual(extractTags(m.body), ['업무', '회의', '거래처']);
    assert.deepEqual(m.aiTags, ['회의', '거래처']);
    assert.equal(m.updated, updated);
    assert.match(fs.readFileSync(path.join(t.dir, t.vault.entries.get(id).file), 'utf8'), /aiTags:/);

    // 사용자가 AI 태그 하나를 지워도 다시 달지 않는다
    t.vault.save(id, m.body.replace(' #거래처', ''));
    await t.tagger.add([id]);
    assert.equal(t.asked.length, 1);
  } finally {
    t.done();
  }
});

test('AI 태그: 열린 메모 · 태그가 이미 3개인 메모는 건너뛰고, 열린 메모는 표시하지 않는다', async () => {
  const open = new Set();
  const t = setup({ open });
  try {
    const full = t.vault.import({ body: '메모 #가 #나 #다' });
    const opened = t.vault.import({ body: '열어 둔 메모' });
    open.add(opened);
    await t.tagger.add([full, opened]);
    assert.equal(t.asked.length, 0);
    assert.equal(t.vault.get(opened).aiTags, null); // 닫을 때 다시
    // "예전 메모에도 달기" 는 건너뛸 메모(태그 3개 · 빈 메모)를 세지 않는다 — 다 달면 끝났다고 보이게
    t.vault.import({ body: '' });
    open.clear();
    assert.equal(t.tagger.all().total, 1);
    await t.tagger.add([]);
    assert.equal(t.tagger.all().total, 0);
  } finally {
    t.done();
  }
});

test('AI 태그: 모든 메모 진행률, 모두 지우기는 AI 태그만 걷어 내고 다시 달지 않는다', async () => {
  const t = setup({ picks: ['회의'] });
  try {
    const a = t.vault.import({ body: '첫 메모' });
    const b = t.vault.import({ body: '둘째 메모 #내태그' });
    assert.deepEqual(t.tagger.all(), { done: 0, total: 2 });
    await t.tagger.add([]);
    assert.deepEqual(t.progress.at(-1), null);
    assert.deepEqual(t.progress.filter(Boolean).map((p) => p.done), [0, 1]);
    assert.equal(t.tagger.clearAll(), 2);
    assert.deepEqual(extractTags(t.vault.get(a).body), []);
    assert.deepEqual(extractTags(t.vault.get(b).body), ['내태그']);
    assert.deepEqual(t.vault.get(b).aiTags, []);
    assert.deepEqual(t.tagger.all(), { done: 0, total: 0 });
  } finally {
    t.done();
  }
});

test('AI 태그: 모델 오류면 표시하지 않고 한꺼번에 하던 것을 멈춘다', async () => {
  const t = setup();
  try {
    const id = t.vault.import({ body: '메모' });
    const progress = [];
    const tagger = createAiTagger({
      getVault: () => t.vault, tasks: () => ({ autoTags: async () => { throw new Error('모델이 멈췄어요'); } }),
      ready: async () => true, isOpen: () => false, enabled: () => true, onProgress: (p) => progress.push(p),
    });
    tagger.all();
    await tagger.add([]);
    assert.equal(t.vault.get(id).aiTags, null);
    assert.match(progress.at(-1).error, /모델이 멈췄어요/);
    assert.equal(tagger.status(), null);
  } finally {
    t.done();
  }
});

test('removeTags: 태그만 있는 줄에서만 빼고, 빈 줄이 되면 그 줄도', () => {
  assert.equal(removeTags('본문 #회의 그대로\n\n#업무 #회의\n', ['회의']), '본문 #회의 그대로\n\n#업무\n');
  assert.equal(removeTags('본문\n\n#회의\n', ['회의']), '본문\n');
});

test('AI 뒤처리: 새로 쓴 줄의 일정을 넣고, 본 줄은 다시 묻지 않으며, 오래된 메모는 처음엔 본 줄로만', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-aievent-'));
  const vault = new Vault(dir);
  vault.open();
  const asked = [];
  const added = [];
  const written = [];
  const tagger = createAiTagger({
    getVault: () => vault, ready: async () => true, isOpen: () => false, enabled: () => false, eventsOn: () => true,
    onEvents: (id, events) => added.push(...events),
    tasks: () => ({ autoEvents: async (body, o) => {
      written.push(o.written);
      const { createAiTasks } = await import('../app/js/core/ai-tasks.js');
      return createAiTasks({ ai: { chat: async (m) => { asked.push(m[1].content); return '{"events":[{"n":1,"title":"치과"}]}'; } }, memos: () => [], graph: () => [] }).autoEvents(body, o);
    } }),
  });
  try {
    const id = vault.import({ body: '내일 오후 3시 치과' });
    await tagger.add([id]);
    assert.equal(vault.get(id).reminders.length, 1);
    assert.equal(added[0].title, '치과');
    assert.equal(written[0].getTime(), Date.parse(vault.get(id).updated)); // "내일" 은 처리한 때가 아니라 고친 때 기준
    vault.save(id, `${vault.get(id).body}\n메모 더 씀`);
    await tagger.add([id]);
    assert.equal(asked.length, 1); // 본 줄은 다시 묻지 않음

    const old = vault.import({ body: '내일 오후 4시 미팅', created: '2025-01-01T09:00:00+09:00' });
    await tagger.add([old]);
    assert.equal(vault.get(old).reminders.length, 0);
    assert.deepEqual(vault.get(old).aiEvents, ['내일 오후 4시 미팅']);
    assert.equal(asked.length, 1);
  } finally {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
