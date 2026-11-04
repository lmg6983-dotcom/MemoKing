import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOWS_SETUP, ANDROID_APK, installShareText } from '../app/js/core/install-links.js';

test('설치 링크: 버전이 들어가지 않은 늘 같은 주소 (새 버전이 나와도 그대로)', () => {
  assert.equal(WINDOWS_SETUP, 'https://github.com/lmg6983-dotcom/MemoKing/releases/latest/download/MemoKing-Setup.exe');
  assert.equal(ANDROID_APK, 'https://github.com/lmg6983-dotcom/MemoKing/releases/download/android/MemoKing-android.apk');
  assert.doesNotMatch(WINDOWS_SETUP + ANDROID_APK, /\d+\.\d+\.\d+/);
});

test('설치 링크: release.yml 이 PC 설치 파일을 같은 이름으로도 올린다', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(yml, /files=\([^\n]* MemoKing-Setup\.exe\)/); // Release 에 올리는 파일 목록
  assert.match(yml, /gh release (create|upload) [^\n]*"\$\{files\[@\]\}"/);
});

test('나눠 줄 글에 두 링크가 모두', () => {
  const t = installShareText();
  assert.ok(t.includes(WINDOWS_SETUP) && t.includes(ANDROID_APK));
});
