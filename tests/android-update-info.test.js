import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradleVersion, notesFor, buildInfo, APK_URL } from '../scripts/android-update-info.mjs';

const gradle = 'defaultConfig {\n    versionCode = 110\n    versionName = "0.32.0"\n}';
const readme = [
  '| 태그 | 날짜 | 단계 | 내용 |',
  '|---|---|---|---|',
  '| `v0.46.0` | 2026-10-19 | 3. 개선 | **새 기능**: 앱 안 업데이트. 서식 지우기 (휴대폰 0.32.0) |',
  '| `v0.45.0` | 2026-10-18 | 3. 검수 | **검수** (휴대폰 0.31.0) |',
].join('\n');

test('휴대폰 앱 업데이트 정보: build.gradle.kts 의 버전', () => {
  assert.deepEqual(gradleVersion(gradle), { versionCode: 110, versionName: '0.32.0' });
  assert.throws(() => gradleVersion('아무 글'), /찾지 못했어요/);
});

test('휴대폰 앱 업데이트 정보: 바뀐 점은 README 의 그 휴대폰 버전 줄', () => {
  assert.equal(notesFor(readme, '0.32.0'), '**새 기능**: 앱 안 업데이트. 서식 지우기 (휴대폰 0.32.0)');
  assert.equal(notesFor(readme, '0.31.0'), '**검수** (휴대폰 0.31.0)');
  assert.equal(notesFor(readme, '9.9.9'), '메모킹 휴대폰 9.9.9'); // 줄이 없으면 한 줄 안내
  assert.equal(notesFor(readme, '0.32'), '메모킹 휴대폰 0.32'); // 앞부분만 같은 버전을 잘못 집지 않음
});

test('휴대폰 앱 업데이트 정보: 크기 · SHA-256 · 받을 주소', () => {
  const info = buildInfo({ gradle, readme, apkBytes: Buffer.from('abc') });
  assert.equal(info.versionCode, 110);
  assert.equal(info.size, 3);
  assert.equal(info.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(info.apk, APK_URL);
  assert.match(info.apk, /^https:\/\/github\.com\/lmg6983-dotcom\/memoking-releases\/releases\/download\/android\/.+\.apk$/);
});
