#!/usr/bin/env node
// Electron 실행기 — npm 캐시에 받아 둔 Electron 으로 앱을 띄운다 (프로젝트에 node_modules 없음).
//   npm start               앱 실행 (이 터미널에 로그가 보임, 터미널을 닫으면 앱도 꺼짐)
//   npm run launch          앱을 띄우고 터미널은 바로 끝남 (알림 영역에 상주) — 메모킹 실행.cmd 가 사용
//   npm run smoke           자동 점검
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ELECTRON_VERSION = '44.4.5';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const detach = argv.includes('--detach');

// VS Code 등에서 이 값이 설정돼 있으면 Electron 이 앱이 아닌 Node 로 실행된다.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['-y', `electron@${ELECTRON_VERSION}`, '.', ...argv.filter((a) => a !== '--detach')];
const options = detach
  ? { cwd: ROOT, env, stdio: 'ignore', detached: true, windowsHide: true }
  : { cwd: ROOT, env, stdio: 'inherit' };
// 윈도우에서는 npx 가 .cmd 파일이라 셸을 거쳐야 실행된다.
const child = process.platform === 'win32'
  ? spawn(['npx', ...args].join(' '), { ...options, shell: true })
  : spawn('npx', args, options);

if (detach) {
  child.unref();
  process.exit(0);
} else {
  child.on('exit', (code) => process.exit(code ?? 1));
}
