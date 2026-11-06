#!/usr/bin/env node
// 오픈소스 라이브러리를 app/vendor/ 에 한 파일씩 묶는다.  사용법: npm run vendor
//
// node_modules 는 Google Drive 동기화 부담을 피하려고 프로젝트 밖
// (%LOCALAPPDATA%\memoking-build) 에 설치하고, 묶은 결과물만 프로젝트에 넣는다.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEPS = {
  '@milkdown/kit': '7.22.2',
  yaml: '2.9.1',
  plyr: '3.8.4',
  pretendard: '1.3.9',
  katex: '0.16.22',
  'remark-math': '6.0.0',
  'html-to-image': '1.11.13',
  'chrono-node': '2.10.1',
  '@modelcontextprotocol/sdk': '1.30.1',
  zod: '4.6.5',
  '@noble/ciphers': '2.4.0',
  '@noble/hashes': '2.4.0',
  fullcalendar: '7.1.0',
  'temporal-polyfill': '1.0.5',
  'ical.js': '2.2.1',
  'pdfjs-dist': '5.4.149',
  'docx-preview': '0.4.1',
  'hwp.js': '0.0.3',
  jszip: '3.10.1',
  esbuild: '0.28.2',
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'memoking-build');
const MODULES = join(BUILD, 'node_modules');
const OUT = join(ROOT, 'app', 'vendor');

function installedVersion(name) {
  const file = join(MODULES, name, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null;
}

// 1) 빌드 폴더에 정해진 버전 설치
mkdirSync(BUILD, { recursive: true });
const missing = Object.entries(DEPS).filter(([name, version]) => installedVersion(name) !== version);
if (missing.length) {
  writeFileSync(join(BUILD, 'package.json'), JSON.stringify({ name: 'memoking-build', private: true, type: 'module' }));
  // 빠진 것만 설치하면 npm 이 package.json 에 없는 나머지를 지우므로 늘 모두 함께
  const specs = Object.entries(DEPS).map(([name, version]) => `${name}@${version}`).join(' ');
  console.log(`설치: ${specs}  →  ${BUILD}`);
  execSync(`npm install --no-audit --no-fund ${specs}`, { cwd: BUILD, stdio: 'inherit' });
}

// 2) 묶기
const esbuild = await import(pathToFileURL(join(MODULES, 'esbuild', 'lib', 'main.js')).href);
mkdirSync(OUT, { recursive: true });
await esbuild.build({
  entryPoints: {
    milkdown: join(ROOT, 'scripts', 'vendor', 'milkdown.js'),
    yaml: join(ROOT, 'scripts', 'vendor', 'yaml.js'),
    plyr: join(ROOT, 'scripts', 'vendor', 'plyr.js'),
    katex: join(ROOT, 'scripts', 'vendor', 'katex.js'),
    'html-to-image': join(ROOT, 'scripts', 'vendor', 'html-to-image.js'),
    chrono: join(ROOT, 'scripts', 'vendor', 'chrono.js'),
    'noble-crypto': join(ROOT, 'scripts', 'vendor', 'noble-crypto.js'),
    fullcalendar: join(ROOT, 'scripts', 'vendor', 'fullcalendar.js'),
    ical: join(ROOT, 'scripts', 'vendor', 'ical.js'),
  },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  nodePaths: [MODULES],
  logLevel: 'info',
});
// 문서를 그림으로 (PDF · Word · 한글): 브라우저용으로 따로 — jszip 의 node 스트림은 빼고, hwp.js 가 부르는 fs 는 빈 모듈로
const emptyModule = join(BUILD, 'empty.js');
writeFileSync(emptyModule, 'export default {};\n');
await esbuild.build({
  entryPoints: { docpages: join(ROOT, 'scripts', 'vendor', 'docpages.js') },
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  nodePaths: [MODULES],
  alias: { fs: emptyModule },
  logLevel: 'info',
});
copyFileSync(join(MODULES, 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs'), join(OUT, 'pdf.worker.js'));
// AI 비서 연결(MCP) 서버는 PC 메인 프로세스(node)에서만 — desktop/vendor 로 따로
await esbuild.build({
  entryPoints: { 'mcp-sdk': join(ROOT, 'scripts', 'vendor', 'mcp-sdk.js') },
  outdir: join(ROOT, 'desktop', 'vendor'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: true,
  legalComments: 'eof',
  nodePaths: [MODULES],
  logLevel: 'info',
  // esm 묶음 안의 require (일부 의존성) 를 위해
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
copyFileSync(join(MODULES, '@milkdown', 'prose', 'lib', 'style', 'prosemirror.css'), join(OUT, 'prosemirror.css'));
copyFileSync(join(MODULES, 'plyr', 'dist', 'plyr.css'), join(OUT, 'plyr.css'));
// 달력(FullCalendar): 뼈대 · 테마 · 색 한 파일로 (색은 list.css 에서 메모킹 색으로 덮는다)
writeFileSync(join(OUT, 'fullcalendar.css'), ['skeleton.css', join('themes', 'forma', 'theme.css'), join('themes', 'forma', 'palettes', 'blue.css')]
  .map((f) => `/* fullcalendar/${f.replace(/\\/g, '/')} (MIT) */\n${readFileSync(join(MODULES, 'fullcalendar', f), 'utf8')}`).join('\n'));
// 브랜드 글꼴 Pretendard (가변 글꼴 하나로 모든 굵기) — 인터넷 없이 쓰도록 앱에 넣는다
mkdirSync(join(OUT, 'fonts'), { recursive: true });
copyFileSync(join(MODULES, 'pretendard', 'dist', 'web', 'variable', 'woff2', 'PretendardVariable.woff2'), join(OUT, 'fonts', 'PretendardVariable.woff2'));
// 수식(KaTeX): 글꼴은 woff2 만 넣고(앱 안에서만 쓰므로) css 도 woff2 만 가리키게
mkdirSync(join(OUT, 'katex', 'fonts'), { recursive: true });
const katexDist = join(MODULES, 'katex', 'dist');
for (const f of readdirSync(join(katexDist, 'fonts'))) if (f.endsWith('.woff2')) copyFileSync(join(katexDist, 'fonts', f), join(OUT, 'katex', 'fonts', f));
writeFileSync(join(OUT, 'katex', 'katex.css'), readFileSync(join(katexDist, 'katex.min.css'), 'utf8')
  .replace(/src:url\((fonts\/[^)]+\.woff2)\) format\("woff2"\)(,url\([^)]+\) format\("[^"]+"\))*/g, 'src:url($1) format("woff2")'));
// Plyr 아이콘은 기본값이 인터넷(CDN)에서 받아오기라, 문서에 직접 심을 수 있게 문자열 모듈로 만든다.
const sprite = readFileSync(join(MODULES, 'plyr', 'dist', 'plyr.svg'), 'utf8');
writeFileSync(join(OUT, 'plyr-sprite.js'), `// Plyr 아이콘 (plyr/dist/plyr.svg, MIT)\nexport default ${JSON.stringify(sprite)};\n`);

// 3) 라이선스 목록
const licenses = Object.keys(DEPS)
  .filter((name) => name !== 'esbuild')
  .map((name) => {
    const pkg = JSON.parse(readFileSync(join(MODULES, name, 'package.json'), 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    return `| ${name} | ${pkg.version} | ${pkg.license} | ${repo.replace(/^git\+/, '').replace(/\.git$/, '')} |`;
  });
// 따로 넣은 것(canvas-confetti·tesseract.js 등 — 이 스크립트가 묶지 않음)은 손으로 적은 줄을 그대로 둔다
const bundled = new Set(Object.keys(DEPS));
const kept = existsSync(join(OUT, 'LICENSES.md'))
  ? readFileSync(join(OUT, 'LICENSES.md'), 'utf8').split('\n').filter((l) => /^\| [^-|]/.test(l) && !l.startsWith('| 패키지') && !bundled.has(l.split('|')[1].trim()))
  : [];
writeFileSync(
  join(OUT, 'LICENSES.md'),
  ['# 포함된 오픈소스', '', '| 패키지 | 버전 | 라이선스 | 저장소 |', '|---|---|---|---|', ...licenses, ...kept, ''].join('\n'),
);
console.log('✔ app/vendor/ 갱신 완료');
