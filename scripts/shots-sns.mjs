#!/usr/bin/env node
// SNS 소개 자료용 화면 찍기: 홈 폴더를 임시 폴더로 바꿔(내 PC 파일이 사진에 나오지 않게) 2배 화질로 desktop/smoke-sns.js 를 돌린다
//   결과: out/sns/*.png · out/sns/scenes.json
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'mk-sns-home-'));
const r = spawnSync(process.execPath, [join(import.meta.dirname, 'electron.mjs'), '--force-device-scale-factor=2', '--smoke', '--sns', ...process.argv.slice(2)], {
  stdio: 'inherit',
  // npm 캐시(받아 둔 Electron)는 원래 홈의 것을 그대로
  env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm') },
});
process.exit(r.status ?? 1);
