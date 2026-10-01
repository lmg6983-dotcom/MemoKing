#!/usr/bin/env node
// 개발 단계 기록 스크립트 — 단계가 끝날 때마다 실행한다.
//   사용법: npm run stage -- <plan|build|feedback> <버전> "<요약>"
//   예시:   npm run stage -- build 0.2.0 "휴지통 기능 추가"
//
// 하는 일: package.json 버전 갱신(build) → README 히스토리 추가 → git 커밋·태그 → zip 백업

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGES = {
  plan: { label: '1. 계획', tag: (v) => `v${v}-plan` },
  build: { label: '2. 생성', tag: (v) => `v${v}` },
  feedback: { label: '3. 피드백', tag: (v) => `v${v}-feedback` },
};

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const [stage, version, ...rest] = process.argv.slice(2);
const summary = rest.join(' ').trim();

if (!STAGES[stage] || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !summary) {
  fail('사용법: npm run stage -- <plan|build|feedback> <버전 예: 0.2.0> "<요약>"');
}

const tag = STAGES[stage].tag(version);
if (git('tag', '--list', tag)) fail(`이미 존재하는 태그입니다: ${tag}`);

const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (로컬 시간)

// 1) 생성 단계: package.json 버전 갱신
if (stage === 'build') {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// 2) README 히스토리 표 맨 위에 한 줄 추가
const readmePath = join(ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const start = readme.indexOf('<!-- HISTORY:START -->');
const separator = /^\|(?:\s*-+\s*\|)+[ \t]*\r?\n/m;
const sepMatch = start === -1 ? null : separator.exec(readme.slice(start));
if (!sepMatch) fail('README.md 에서 히스토리 표(<!-- HISTORY:START --> 아래)를 찾을 수 없습니다.');

const insertAt = start + sepMatch.index + sepMatch[0].length;
const row = `| \`${tag}\` | ${today} | ${STAGES[stage].label} | ${summary.replace(/\|/g, '\\|')} |\n`;
writeFileSync(readmePath, readme.slice(0, insertAt) + row + readme.slice(insertAt));

// 3) git 커밋 + 태그
git('add', '-A');
const trailer = process.env.COMMIT_TRAILER ? `\n\n${process.env.COMMIT_TRAILER}` : '';
git('commit', '-m', `${stage}: ${tag} ${summary}${trailer}`);
git('tag', '-a', tag, '-m', `${STAGES[stage].label} ${tag} — ${summary}`);

// 4) zip 백업 (git 에 커밋된 파일 기준)
const backupDir = join(ROOT, 'backups');
mkdirSync(backupDir, { recursive: true });
const zipPath = join(backupDir, `메모킹_${tag}_${today}.zip`);
git('archive', '--format=zip', '-o', zipPath, tag);

console.log(`✔ ${STAGES[stage].label} 단계 기록 완료`);
console.log(`  태그:   ${tag}`);
console.log(`  백업:   backups/메모킹_${tag}_${today}.zip`);
console.log(`  히스토리: README.md 에 추가됨`);
