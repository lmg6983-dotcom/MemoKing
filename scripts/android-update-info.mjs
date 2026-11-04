// 앱 안 업데이트용 정보 파일(android-latest.json) 만들기 — android.yml 이 APK 를 릴리스 "android" 에 올릴 때 함께 올린다
//   사용: node scripts/android-update-info.mjs <APK 경로> <만들 JSON 경로>
//   { versionCode, versionName, apk(내려받을 주소), size, sha256, notes } — 앱(AppUpdate.kt)이 이것을 보고 새 버전인지 판단한다
//   바뀐 점(notes)은 README 이력 표에서 "(휴대폰 <versionName>)" 이 적힌 줄 (PC 의 새 버전 안내와 같은 글)
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// RELEASES_REPO: 올릴 저장소 (옛 배포 저장소에 올릴 때는 그쪽 주소여야 옛 앱이 받는다)
export const APK_URL = `https://github.com/${process.env.RELEASES_REPO || 'lmg6983-dotcom/MemoKing'}/releases/download/android/MemoKing-android.apk`;

/** android/app/build.gradle.kts 의 versionCode · versionName */
export function gradleVersion(text) {
  const code = text.match(/versionCode\s*=\s*(\d+)/);
  const name = text.match(/versionName\s*=\s*"([^"]+)"/);
  if (!code || !name) throw new Error('build.gradle.kts 에서 versionCode · versionName 을 찾지 못했어요');
  return { versionCode: Number(code[1]), versionName: name[1] };
}

/** README 이력 표에서 이 휴대폰 버전이 적힌 줄의 내용 칸 (없으면 한 줄 안내) */
export function notesFor(readme, versionName) {
  const row = readme.split('\n').find((l) => l.startsWith('| `v') && l.includes(`휴대폰 ${versionName})`));
  if (!row) return `메모킹 휴대폰 ${versionName}`;
  const cells = row.split(' | ');
  return cells.slice(3).join(' | ').replace(/\s*\|\s*$/, '').trim() || `메모킹 휴대폰 ${versionName}`;
}

export function buildInfo({ gradle, readme, apkBytes }) {
  const { versionCode, versionName } = gradleVersion(gradle);
  return {
    versionCode,
    versionName,
    apk: APK_URL,
    size: apkBytes.length,
    sha256: createHash('sha256').update(apkBytes).digest('hex'),
    notes: notesFor(readme, versionName),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [apkPath, outPath] = process.argv.slice(2);
  if (!apkPath || !outPath) throw new Error('사용: node scripts/android-update-info.mjs <APK> <JSON>');
  const info = buildInfo({
    gradle: readFileSync(join(ROOT, 'android/app/build.gradle.kts'), 'utf8'),
    readme: readFileSync(join(ROOT, 'README.md'), 'utf8'),
    apkBytes: readFileSync(apkPath),
  });
  writeFileSync(outPath, JSON.stringify(info, null, 2));
  console.log(`${outPath}: v${info.versionName} (${info.versionCode}) · ${(statSync(apkPath).size / 1048576).toFixed(1)}MB`);
}
