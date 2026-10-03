#!/usr/bin/env node
// 배포판(설치 파일) 만들기 — npm run dist
//
// Google Drive 동기화 부담을 피하려고 %LOCALAPPDATA%\memoking-build 에서 조립·빌드하고,
// 완성된 설치 파일만 프로젝트의 dist\ 로 복사한다. 이어서 빌드된 실행 파일로 자동 점검을 한 번 돌린다.
//   npm run dist               빌드 + 빌드된 앱으로 자동 점검
//   npm run dist -- --no-smoke 빌드만
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ELECTRON_VERSION = '44.4.5';
const BUILDER_VERSION = '26.15.3';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'memoking-build');
const STAGE = join(BUILD, 'stage');
const OUT = join(BUILD, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const runSmoke = !process.argv.includes('--no-smoke');

// 1) electron-builder 준비 (프로젝트 밖에 설치)
const builderPkg = join(BUILD, 'node_modules', 'electron-builder', 'package.json');
if (!existsSync(builderPkg) || JSON.parse(readFileSync(builderPkg, 'utf8')).version !== BUILDER_VERSION) {
  console.log(`설치: electron-builder@${BUILDER_VERSION} → ${BUILD}`);
  mkdirSync(BUILD, { recursive: true }); // 처음 빌드하는 컴퓨터에는 폴더가 없다
  execSync(`npm install --no-audit --no-fund electron-builder@${BUILDER_VERSION}`, { cwd: BUILD, stdio: 'inherit' });
}

// 2) 앱에 들어갈 파일만 조립 (개발용 스크립트·테스트·문서·백업·아이콘 원본은 빼고)
// fs.cpSync 는 Google Drive 폴더(한글 경로)에서 Node 가 비정상 종료하는 문제가 있어 직접 복사한다.
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const item of readdirSync(from, { withFileTypes: true })) {
    if (item.name === 'desktop.ini') continue;
    const src = join(from, item.name);
    const dest = join(to, item.name);
    if (item.isDirectory()) copyDir(src, dest);
    else if (item.isFile()) copyFileSync(src, dest);
  }
}
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const dir of ['app', 'desktop', join('assets', 'icons')]) copyDir(join(ROOT, dir), join(STAGE, dir));
mkdirSync(join(STAGE, 'scripts'), { recursive: true });
copyFileSync(join(ROOT, 'scripts', 'clipboard-helper.ps1'), join(STAGE, 'scripts', 'clipboard-helper.ps1'));
copyFileSync(join(ROOT, 'scripts', 'popup-watch.ps1'), join(STAGE, 'scripts', 'popup-watch.ps1'));
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  type: 'module',
  main: 'desktop/main.js',
}, null, 2));

// 3) 빌드
const config = {
  appId: 'com.memoking.desktop', // 앱 안의 AppUserModelId 와 같아야 Windows 알림이 "메모킹" 으로 뜬다
  productName: 'MemoKing',
  copyright: 'Copyright © 2026 lmg6983@gmail.com',
  electronVersion: ELECTRON_VERSION,
  directories: { output: OUT },
  files: ['**/*'],
  asar: true,
  // PowerShell 이 읽어야 하는 도우미와, 숨은 OCR 창이 워커·wasm 으로 불러오는 tesseract 파일은 asar 밖에 둔다
  asarUnpack: ['scripts/clipboard-helper.ps1', 'scripts/popup-watch.ps1', 'app/vendor/tesseract/**'],
  npmRebuild: false,
  nodeGypRebuild: false,
  publish: null, // 자동 업데이트·배포 안 함 (없으면 배포 대상을 찾다가 멈출 수 있다)
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icons/memoking.ico',
    artifactName: 'MemoKing-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false, // 사용자별 설치 — 관리자 권한 불필요
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '메모킹',
    uninstallDisplayName: '메모킹',
    installerLanguages: ['ko_KR'],
    language: '1042',
    installerIcon: 'assets/icons/memoking.ico',
    uninstallerIcon: 'assets/icons/memoking.ico',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // 설정·알림 보관함은 남긴다 (메모는 원래 메모 폴더에 있음)
  },
};
const builder = await import(pathToFileURL(join(BUILD, 'node_modules', 'electron-builder', 'out', 'index.js')).href);
rmSync(OUT, { recursive: true, force: true });
console.log(`빌드: 메모킹 v${pkg.version} (Electron ${ELECTRON_VERSION})`);
await builder.build({ projectDir: STAGE, config, targets: builder.Platform.WINDOWS.createTarget() });

const setupName = `MemoKing-Setup-${pkg.version}.exe`;
mkdirSync(join(ROOT, 'dist'), { recursive: true });
copyFileSync(join(OUT, setupName), join(ROOT, 'dist', setupName));
console.log(`✔ 설치 파일: dist/${setupName}`);

// 4) 빌드된 실행 파일로 자동 점검 (설치 전 폴더의 MemoKing.exe)
if (runSmoke) {
  const exe = join(OUT, 'win-unpacked', 'MemoKing.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('빌드된 앱으로 자동 점검 중…');
  const r = spawnSync(exe, ['--smoke'], { env, encoding: 'utf8', timeout: 10 * 60_000 });
  const lines = `${r.stdout ?? ''}`.split(/\r?\n/).filter((l) => /^[✔✖]|자동 점검|^\s{4}/.test(l));
  console.log(lines.join('\n'));
  if (r.status !== 0) {
    console.error(`✖ 빌드된 앱 점검 실패 (종료 코드 ${r.status})`);
    process.exit(1);
  }
}
