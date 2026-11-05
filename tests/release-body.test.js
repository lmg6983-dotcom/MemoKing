import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseBody } from '../scripts/release-body.mjs';

const readme = [
  '| 태그 | 날짜 | 단계 | 내용 |',
  '|---|---|---|---|',
  '| `v0.2.0` | 2026-11-05 | 3. 개선 | **빠른 검색**: 검색이 빨라졌어요. 목록도 가벼워요 (휴대폰 0.1.0) |',
  '| `v0.1.0-plan` | 2026-11-01 | 1. 계획 | 계획 |',
  '| `v0.1.0` | 2026-11-01 | 2. 생성 | 처음 |',
].join('\n');

test('릴리스 본문: 제목 · 항목 · 받기 표 · 지난 정식 버전과 비교', () => {
  const body = releaseBody(readme, '0.2.0');
  assert.match(body, /^## ✨ 바뀐 점\n\n### 빠른 검색\n\n- 검색이 빨라졌어요\n- 목록도 가벼워요 \(휴대폰 0\.1\.0\)\n/);
  assert.match(body, /releases\/download\/v0\.2\.0\/MemoKing-Setup-0\.2\.0\.exe/);
  assert.match(body, /compare\/v0\.1\.0\.\.\.v0\.2\.0/); // -plan 태그는 건너뛴다
  assert.doesNotMatch(body, /\n{3}/);
});

test('릴리스 본문: 이력에 없는 버전 · 첫 버전은 비교 링크 없이', () => {
  assert.match(releaseBody(readme, '9.9.9'), /메모킹 v9\.9\.9/);
  assert.doesNotMatch(releaseBody(readme, '0.1.0'), /compare/);
});
