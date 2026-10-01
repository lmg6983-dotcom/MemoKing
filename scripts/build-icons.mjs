#!/usr/bin/env node
// 아이콘 시안(assets/source/memoking-icon-sheet.png)에서 앱 아이콘들을 만든다.  사용법: npm run icons
// 필요: ImageMagick 7 (magick 명령)
//
// 시안의 256px 그림(왕관 + 스티커 메모 + 연필)만 잘라 쓴다. "메모킹" 글자는 작은 크기에서 뭉개지므로 뺀다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'assets', 'source', 'memoking-icon-sheet.png');
const ICONS = join(ROOT, 'assets', 'icons');
const APP_ASSETS = join(ROOT, 'app', 'assets');

// 시안에서 256px 그림이 있는 영역 (글자는 y 505 부터라 그 위까지만)
const MARK_REGION = '540x450+138+48';
// 16~24px 용 간략형: 연필을 빼고 왕관 + 메모만 (작은 크기에서 훨씬 또렷함)
const COMPACT_REGION = '362x450+138+48';
const COMPACT_MAX = 24;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const magick = (...args) => execFileSync('magick', args, { encoding: 'utf8' }).trim();

try {
  magick('-version');
} catch {
  console.error('✖ ImageMagick(magick) 이 필요합니다: https://imagemagick.org');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'memoking-icons-'));
mkdirSync(ICONS, { recursive: true });
mkdirSync(APP_ASSETS, { recursive: true });

// 1) 잘라내기 + 배경의 옅은 얼룩(알파 8% 미만) 제거 + 여백 정리
// 2) 정사각형 캔버스 가운데에 (둘레 3% 여백) → 512px 원본
function makeMaster(region, name) {
  const cut = join(work, `${name}-cut.png`);
  magick(SOURCE, '-crop', region, '+repage', '-channel', 'A', '-level', '8%,100%', '+channel', '-trim', '+repage', cut);
  const [w, h] = magick(cut, '-format', '%w %h', 'info:').split(' ').map(Number);
  const side = Math.ceil(Math.max(w, h) * 1.06);
  const out = join(work, `${name}.png`);
  magick(cut, '-background', 'none', '-gravity', 'center', '-extent', `${side}x${side}`, '-resize', '512x512', out);
  return { file: out, w, h, side };
}
const master = makeMaster(MARK_REGION, 'master');
const compact = makeMaster(COMPACT_REGION, 'compact');
const { w, h, side } = master;

// 3) 크기별 PNG — 작은 크기는 간략형을 쓰고, 축소로 흐려진 것을 살짝 선명하게.
//    PNG32: 를 붙여 팔레트(256색) PNG 로 저장되지 않게 한다 (ico 의 작은 크기가 깨지는 원인).
function sized(size, out) {
  const from = size <= COMPACT_MAX ? compact.file : master.file;
  const sharpen = size <= 32 ? ['-unsharp', '0x0.5+0.6+0'] : size <= 64 ? ['-unsharp', '0x0.5+0.4+0'] : [];
  magick(from, '-filter', 'Lanczos', '-resize', `${size}x${size}`, ...sharpen, '-strip', `PNG32:${out}`);
  return out;
}

const icoParts = ICO_SIZES.map((s) => sized(s, join(work, `icon-${s}.png`)));
// 색이 적은 16px 도 32비트(반투명 가장자리 유지)로 저장되게 한다.
magick(...icoParts, '-type', 'TrueColorAlpha', '-define', 'bmp:format=bmp4', join(ICONS, 'memoking.ico'));
sized(512, join(ICONS, 'icon-512.png'));
sized(256, join(ICONS, 'icon-256.png'));
sized(64, join(APP_ASSETS, 'mark-64.png'));
sized(256, join(APP_ASSETS, 'mark-256.png'));

// 확인용 한눈에 보기 (밝은·어두운 배경)
const previews = ICO_SIZES.map((s) => join(work, `icon-${s}.png`));
for (const [name, bg] of [['preview-light.png', '#f6f5f1'], ['preview-dark.png', '#16171a']]) {
  magick('-background', bg, ...previews, '-gravity', 'center', '+append', '-bordercolor', bg, '-border', '12', join(ICONS, name));
}

rmSync(work, { recursive: true, force: true });
console.log(`✔ 아이콘 생성 완료 (원본 그림 ${w}×${h} → 정사각형 ${side}px)`);
console.log('  assets/icons/memoking.ico  (' + ICO_SIZES.join('·') + ')');
console.log('  assets/icons/icon-512.png, icon-256.png, preview-light.png, preview-dark.png');
console.log('  app/assets/mark-64.png, mark-256.png');
