#!/usr/bin/env node
// 오픈소스 라이브러리를 app/vendor/ 에 한 파일씩 묶는다.  사용법: npm run vendor
//
// node_modules 는 Google Drive 동기화 부담을 피하려고 프로젝트 밖
// (%LOCALAPPDATA%\memoking-build) 에 설치하고, 묶은 결과물만 프로젝트에 넣는다.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEPS = {
  '@milkdown/kit': '7.22.2',
  yaml: '2.9.1',
  plyr: '3.8.4',
  pretendard: '1.3.9',
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
  const specs = missing.map(([name, version]) => `${name}@${version}`).join(' ');
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
copyFileSync(join(MODULES, '@milkdown', 'prose', 'lib', 'style', 'prosemirror.css'), join(OUT, 'prosemirror.css'));
copyFileSync(join(MODULES, 'plyr', 'dist', 'plyr.css'), join(OUT, 'plyr.css'));
// 브랜드 글꼴 Pretendard (가변 글꼴 하나로 모든 굵기) — 인터넷 없이 쓰도록 앱에 넣는다
mkdirSync(join(OUT, 'fonts'), { recursive: true });
copyFileSync(join(MODULES, 'pretendard', 'dist', 'web', 'variable', 'woff2', 'PretendardVariable.woff2'), join(OUT, 'fonts', 'PretendardVariable.woff2'));
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
writeFileSync(
  join(OUT, 'LICENSES.md'),
  ['# 포함된 오픈소스', '', '| 패키지 | 버전 | 라이선스 | 저장소 |', '|---|---|---|---|', ...licenses, ''].join('\n'),
);
console.log('✔ app/vendor/ 갱신 완료');
