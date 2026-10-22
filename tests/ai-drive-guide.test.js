import test from 'node:test';
import assert from 'node:assert/strict';
import { aiDrivePrompt } from '../app/js/ai-drive-guide.js';
import { parseMemoFile, extractTitle, COLORS } from '../app/js/core/memo-file.js';
import { normalizeReminder } from '../app/js/core/reminders.js';

test('AI 안내문: 폴더 이름 · .md · Google 문서 금지 · 삭제 전에 묻기 · 색 목록', () => {
  const p = aiDrivePrompt({ folder: '내 메모' });
  assert.match(p, /"내 메모" 폴더/);
  assert.match(p, /\.md/);
  assert.match(p, /Google 문서/);
  assert.match(p, /먼저 저에게 물어봐/);
  for (const c of COLORS) assert.ok(p.includes(c), c);
  assert.ok(!/^id:/m.test(p), '예시 머리말에 id 를 넣지 않는다 (메모킹이 붙인다)');
});

test('AI 안내문의 예시 메모는 메모킹이 그대로 읽는 형식', () => {
  const p = aiDrivePrompt();
  const file = /---\n[\s\S]*?\n---\n# 제목\n\n본문\n/.exec(p)?.[0];
  assert.ok(file, '예시 메모 블록');
  const { meta, body } = parseMemoFile(file);
  assert.equal(extractTitle(body), '제목');
  assert.equal(meta.color, 'yellow');
  assert.equal(meta.mode, 'life');
  assert.equal(meta.created, '2026-10-21T09:30:00+09:00');
  // 일정 예시도 알림으로 읽힌다
  const r = normalizeReminder({ kind: 'at', at: '2026-10-22T15:00:00+09:00', title: '치과' });
  assert.equal(r?.kind, 'at');
});
