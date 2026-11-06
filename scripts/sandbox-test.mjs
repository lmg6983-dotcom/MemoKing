import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), 'memoking-sandbox');
const USER_DATA = path.join(SANDBOX, 'userData');
const VAULT = path.join(SANDBOX, 'vault');

// 1) 샌드박스 폴더 생성
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(VAULT, { recursive: true });

// 2) 샌드박스 설정 파일 생성 (기존 실제 설정과 분리)
const settingsPath = path.join(USER_DATA, 'settings.json');
const settings = {
  vaultPath: VAULT,
  tutorialDone: true,
  openNotes: ['test-list-delete'],
  appsIntroduced: true,
};
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

// 3) 테스트 샘플 메모 파일 자동 생성
const memoPath = path.join(VAULT, 'test-list-delete.md');
const memoContent = `---
title: 기능 테스트 메모
color: yellow
---
# 메모킹 기능 테스트

### 1. [테스트 9번] 목록 맨 앞 Delete
- 1번 항목 (맨 앞에서 Delete를 눌러보세요)
- 2번 항목
- 

1. 번호 목록 1번
2. 번호 목록 2번

- [ ] 할 일 체크박스 항목
- [ ] 

### 2. [테스트 5번] 되돌리기 스낵바 (우측 하단 2초)
아래 표를 마우스 오른쪽 클릭하여 **[표 삭제]**를 눌러보세요:

| 테스트 | 결과 |
| --- | --- |
| 표 내용 | 우클릭 삭제 |

---

### 3. [개선 5번] 메모 목록 단축키 토글
- **Ctrl+Alt+\` (Control+Alt+Backquote)**: 어디서든 메모 목록 창이 앞으로 열리거나 닫힙니다.
`;
fs.writeFileSync(memoPath, memoContent, 'utf8');

console.log('========================================================');
console.log(' [메모킹] 독립 샌드박스 가상 테스트 환경');
console.log('========================================================');
console.log('✔ 기존에 켜져 있는 메모킹과 실제 메모 파일에 전혀 영향을 주지 않습니다.');
console.log(`✔ 임시 테스트 데이터: ${USER_DATA}`);
console.log(`✔ 임시 테스트 메모함: ${VAULT}`);
console.log('\n메모킹 테스트 창을 실행합니다. 잠시만 기다려 주세요...\n');

// 4) 독립된 user-data-dir로 Electron 실행
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn('npx', ['-y', 'electron@44.4.5', '.', `--user-data-dir=${USER_DATA}`], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});

child.on('exit', (code) => {
  console.log(`\n테스트가 종료되었습니다. (종료 코드: ${code ?? 0})`);
  process.exit(code ?? 0);
});
