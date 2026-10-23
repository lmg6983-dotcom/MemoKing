#!/usr/bin/env node
// 로컬 AI 엔진 받기 — llama.cpp(MIT) 의 Windows Vulkan 빌드에서 llama-server.exe 와 DLL 만 desktop/vendor/llama/ 로.
//   npm run llama   (npm run dist 가 없으면 먼저 부른다. 받은 것은 git 에 넣지 않음)
//   Vulkan 이 없는 PC 는 같은 묶음의 CPU 백엔드로 저절로 돈다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LLAMA_TAG = 'b11400'; // 2026-10-05
const ASSET = `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`;
const DEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'vendor', 'llama');
const MARK = join(DEST, 'VERSION');

if (existsSync(join(DEST, 'llama-server.exe')) && existsSync(MARK)) {
  console.log(`AI 엔진 llama.cpp ${LLAMA_TAG}: 이미 있음`);
  process.exit(0);
}

// shortcut: 체크섬을 GitHub 가 올릴 때 잰 값(API digest)으로 확인 — 받다 깨지거나 바뀐 파일은 막지만, 릴리스 자체가 바뀌면 못 막음. 해시를 코드에 박으려면 한 번 받아 본 뒤 여기에
const rel = await (await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_TAG}`)).json();
const asset = rel.assets?.find((a) => a.name === ASSET);
if (!asset?.digest?.startsWith('sha256:')) throw new Error(`${ASSET} 을 릴리스에서 찾지 못했어요`);
console.log(`받기: ${ASSET} (${Math.round(asset.size / 2 ** 20)}MB)`);
const zip = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
const sha = createHash('sha256').update(zip).digest('hex');
if (`sha256:${sha}` !== asset.digest) throw new Error(`체크섬이 달라요: ${sha}`);

const tmp = join(tmpdir(), `memoking-llama-${process.pid}`);
mkdirSync(tmp, { recursive: true });
try {
  writeFileSync(join(tmp, ASSET), zip);
  execFileSync('tar', ['-xf', ASSET], { cwd: tmp }); // Windows 10 이상의 tar 는 zip 도 푼다
  const found = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? found(join(dir, d.name)) : [join(dir, d.name)]));
  const files = found(tmp).filter((f) => /[\\/](llama-server\.exe|[^\\/]+\.dll)$/i.test(f)); // 다른 도구(llama-cli 등)는 설치 파일을 키우기만 해서 뺀다
  if (!files.some((f) => /llama-server\.exe$/i.test(f))) throw new Error('묶음에 llama-server.exe 가 없어요');
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const f of files) copyFileSync(f, join(DEST, f.split(/[\\/]/).pop()));
  writeFileSync(MARK, `llama.cpp ${LLAMA_TAG} ${sha}\n`);
  console.log(`AI 엔진: ${DEST} (${files.length}개 파일)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
