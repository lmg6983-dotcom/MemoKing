// 서명한 설치 파일에 맞춰 latest.yml · .blockmap 다시 만들기 — 서명하면 파일이 바뀌어, 그대로 두면 자동 업데이트의 sha512 확인이 실패한다
//   사용: node scripts/refresh-update-info.mjs   (dist/ 의 MemoKing-Setup-<버전>.exe 를 서명본으로 바꾼 뒤, release.yml)
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.MEMOKING_BUILD_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'memoking-build'); // build-dist.mjs 와 같은 곳
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const exe = join(ROOT, 'dist', `MemoKing-Setup-${version}.exe`);
const yml = join(ROOT, 'dist', 'latest.yml');

// electron-builder 가 빌드 때 쓰는 것과 같은 함수 (블록 나누기가 같아야 바뀐 부분만 받기가 맞는다)
const { buildBlockMap } = await import(pathToFileURL(join(BUILD, 'node_modules', 'app-builder-lib', 'out', 'targets', 'blockmap', 'blockmap.js')).href);
const { sha512, size } = await buildBlockMap(exe, 'gzip', `${exe}.blockmap`);

const old = readFileSync(yml, 'utf8');
const oldSha = /sha512: (\S+)/.exec(old)?.[1];
if (!oldSha || !/size: \d+/.test(old)) throw new Error('latest.yml 에서 sha512 · size 를 찾지 못했어요');
writeFileSync(yml, old.replaceAll(oldSha, sha512).replace(/size: \d+/, `size: ${size}`));
console.log(`✔ latest.yml · .blockmap 을 서명한 설치 파일에 맞췄어요 (${size} bytes)`);
