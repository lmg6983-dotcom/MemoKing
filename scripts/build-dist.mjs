#!/usr/bin/env node
// 배포판(설치 파일) 만들기 — npm run dist
//
// Google Drive 동기화 부담을 피하려고 %LOCALAPPDATA%\memoking-build 에서 조립·빌드하고,
// 완성된 설치 파일만 프로젝트의 dist\ 로 복사한다. 이어서 빌드된 실행 파일로 자동 점검을 한 번 돌린다.
//   npm run dist               빌드 + 빌드된 앱으로 자동 점검
//   npm run dist -- --no-smoke 빌드만
//   npm run dist -- --no-smoke --publish always   빌드 + 공개 배포 저장소 Release 에 올리기 (GH_TOKEN 필요 — GitHub Actions 의 release.yml)
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
const publishArg = process.argv[process.argv.indexOf('--publish') + 1];
const PUBLISH = process.argv.includes('--publish') && publishArg === 'always' ? 'always' : 'never';
// 자동 업데이트가 보는 공개 배포 저장소 — 설치 파일 · .blockmap · latest.yml 만 올라간다 (소스 · 토큰은 없음)
const RELEASES = { owner: 'lmg6983-dotcom', repo: 'memoking-releases' };

/** README 이력 표에서 이 버전의 줄 → 릴리스 노트 (앱의 새 버전 대화 상자에 보임) */
function releaseNotes(version) {
  const row = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').find((l) => l.startsWith(`| \`v${version}\` |`));
  if (!row) return `메모킹 v${version}`;
  const cells = row.split(' | ');
  return cells.slice(3).join(' | ').replace(/\s*\|\s*$/, '').trim() || `메모킹 v${version}`;
}

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
execSync('node scripts/get-llama.mjs', { cwd: ROOT, stdio: 'inherit' }); // 로컬 AI 엔진 → desktop/vendor/llama (asar 밖)
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const dir of ['app', 'desktop', join('assets', 'icons')]) copyDir(join(ROOT, dir), join(STAGE, dir));
mkdirSync(join(STAGE, 'scripts'), { recursive: true });
copyFileSync(join(ROOT, 'scripts', 'clipboard-helper.ps1'), join(STAGE, 'scripts', 'clipboard-helper.ps1'));
copyFileSync(join(ROOT, 'scripts', 'popup-watch.ps1'), join(STAGE, 'scripts', 'popup-watch.ps1'));
copyFileSync(join(ROOT, 'README.md'), join(STAGE, 'README.md')); // 업데이트 뒤 한 번 보여 줄 개선된 점 (main.js whatsNew 가 이력 표를 읽는다)
// 설치 파일에 끼우는 NSIS 조각 (electron-builder 가 build/installer.nsh 를 자동으로 읽는다) — 업데이트 때 남은 도우미 프로세스 정리
mkdirSync(join(STAGE, 'build'), { recursive: true });
copyFileSync(join(ROOT, 'scripts', 'installer.nsh'), join(STAGE, 'build', 'installer.nsh'));
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  type: 'module',
  main: 'desktop/main.js',
  dependencies: pkg.dependencies ?? {}, // 앱 안에 들어가는 것 (electron-updater)
}, null, 2));
// 앱이 쓰는 의존성을 조립 폴더에 설치 (개발 중에는 node_modules 없이 npx 로 띄우므로 프로젝트에는 없다)
if (Object.keys(pkg.dependencies ?? {}).length) {
  console.log(`설치: ${Object.entries(pkg.dependencies).map(([n, v]) => `${n}@${v}`).join(', ')} → 조립 폴더`);
  execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', { cwd: STAGE, stdio: 'inherit' });
}

// 3) 빌드
const config = {
  appId: 'com.memoking.desktop', // 앱 안의 AppUserModelId 와 같아야 Windows 알림이 "메모킹" 으로 뜬다
  productName: 'MemoKing',
  copyright: 'Copyright © 2026 lmg6983@gmail.com',
  electronVersion: ELECTRON_VERSION,
  directories: { output: OUT },
  // 점검용 스크립트(desktop/smoke*.js)는 설치 파일에 넣지 않는다 (--smoke 는 개발 실행에서만)
  files: ['**/*', '!desktop/smoke*.js'],
  asar: true,
  // 용량 줄이기: Electron 언어 파일은 한국어 · 영어만 (나머지 50여 개는 앱 화면에 쓰이지 않는다), 설치 파일은 최대 압축
  electronLanguages: ['ko', 'en-US'],
  compression: 'maximum',
  // PowerShell 이 읽어야 하는 도우미와, 숨은 OCR 창이 워커·wasm 으로 불러오는 tesseract 파일은 asar 밖에 둔다
  // 받아쓰기 작업 스레드(desktop/stt)·엔진(desktop/vendor: sherpa-onnx WebAssembly, bzip2)과 그것이 읽는 공용 모듈도
  asarUnpack: ['scripts/clipboard-helper.ps1', 'scripts/popup-watch.ps1', 'app/vendor/tesseract/**', 'desktop/stt/**', 'desktop/vendor/**', 'app/js/core/transcript-lines.js'],
  npmRebuild: false,
  nodeGypRebuild: false,
  // 자동 업데이트: 공개 배포 저장소의 Release (releaseType 'release' — 기본값 draft 는 앱이 볼 수 없다).
  //   이 설정으로 설치 파일 안에 app-update.yml(저장소 주소만, 토큰 없음)이 들어가고, 빌드 결과에 latest.yml · .blockmap 이 생긴다
  publish: [{ provider: 'github', owner: RELEASES.owner, repo: RELEASES.repo, releaseType: 'release' }],
  releaseInfo: { releaseName: `메모킹 v${pkg.version}`, releaseNotes: releaseNotes(pkg.version) },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icons/memoking.ico',
    artifactName: 'MemoKing-Setup-${version}.${ext}',
  },
  nsis: {
    // oneClick: 묻지 않고 바로 설치 → 바로 실행 (0.68.0~ — 폴더를 고르던 화면이 첫인상을 무겁게 했다).
    //   이미 설치한 PC 는 electron-builder 가 기억해 둔 설치 폴더(InstallLocation)에 그대로 덮어쓴다
    oneClick: true,
    perMachine: false, // 사용자별 설치(%LOCALAPPDATA%\Programs) — 관리자 권한 없이 업데이트도 바로
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
console.log(PUBLISH === 'always' ? `배포: ${RELEASES.owner}/${RELEASES.repo} Release v${pkg.version}` : '배포 안 함 (--publish always 로 올림)');
await builder.build({ projectDir: STAGE, config, targets: builder.Platform.WINDOWS.createTarget(), publish: PUBLISH });

const setupName = `MemoKing-Setup-${pkg.version}.exe`;
mkdirSync(join(ROOT, 'dist'), { recursive: true });
copyFileSync(join(OUT, setupName), join(ROOT, 'dist', setupName));
console.log(`✔ 설치 파일: dist/${setupName}`);
// 자동 업데이트에 필요한 것: latest.yml (새 버전 정보) · .blockmap (바뀐 부분만 받기)
for (const f of ['latest.yml', `${setupName}.blockmap`]) {
  if (!existsSync(join(OUT, f))) {
    console.error(`✖ ${f} 가 없어요 — 자동 업데이트가 새 버전을 찾지 못해요 (publish 설정 확인)`);
    process.exit(1);
  }
  copyFileSync(join(OUT, f), join(ROOT, 'dist', f));
  console.log(`✔ ${f}`);
}

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
