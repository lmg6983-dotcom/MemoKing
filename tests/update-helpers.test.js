import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const desktop = path.join(import.meta.dirname, '..', 'desktop');
const sources = fs.readdirSync(desktop).filter((f) => f.endsWith('.js') && !/smoke/.test(f)).map((f) => [f, fs.readFileSync(path.join(desktop, f), 'utf8')]);

// 업데이트가 "Failed to uninstall old application files" 로 멈추던 까닭 가운데 하나: 메모킹이 띄운 PowerShell 이 설치 폴더를
// 작업 폴더로 물려받아 앱이 끝난 뒤에도 그 폴더를 붙잡았다. 새 도우미를 띄울 때 작업 폴더를 정하는 것을 잊지 않게
test('PowerShell 도우미는 설치 폴더가 아닌 임시 폴더를 작업 폴더로 띄운다', () => {
  let found = 0;
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/(?:spawn|execFile|spawnHelper)\(\s*'powershell\.exe'/g)) {
      found++;
      const call = text.slice(m.index, m.index + 700);
      assert.match(call, /cwd:\s*os\.tmpdir\(\)/, `${file}: powershell.exe 를 cwd 없이 띄워요 (${call.slice(0, 60)}…)`);
    }
  }
  assert.ok(found >= 6, `점검할 PowerShell 호출을 ${found}개만 찾았어요`);
});

test('앱이 끝날 때 · 업데이트 직전에 알림 도우미(popupWatcher)도 끈다', () => {
  const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  const willQuit = main.slice(main.indexOf("app.on('will-quit'"));
  assert.match(willQuit.slice(0, 300), /popupWatcher\?\.stop\(\)/);
  assert.match(main, /async function stopHelpers\(\)[\s\S]*?popupWatcher\?\.stop\(\)[\s\S]*?topWatch\.stop\(\)[\s\S]*?captureHelper\.stop\(\)[\s\S]*?desktopPin\.stop\(\)/);
  assert.match(main, /beforeInstall:[\s\S]*?await stopHelpers\(\)/);
});

test('설치 파일은 시작할 때 남은 도우미를 정리한다 (NSIS 조각이 조립 폴더로 복사됨)', () => {
  const nsh = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customInit[\s\S]*mkKillHelpers/);
  assert.match(nsh, /!macro customUnInit[\s\S]*mkKillHelpers/);
  assert.match(nsh, /app\.asar\.unpacked/); // 메모킹 설치 폴더의 도우미만
  assert.ok(!/\$_/.test(nsh.replace(/\$\$_/g, '')), 'NSIS 에서 $ 는 $$ 로 써야 해요');
  const build = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'build-dist.mjs'), 'utf8');
  assert.match(build, /installer\.nsh/);
});
