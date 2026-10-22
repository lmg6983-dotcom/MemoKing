// PowerShell 도우미를 띄우는 규칙 한 곳 — 프로필을 읽지 않고(빠르게) · 묻지 않고 · 스크립트 실행을 허용,
//   작업 폴더는 임시 폴더(설치 폴더를 작업 폴더로 물려받으면 업데이트 때 그 폴더를 지우지 못한다) · 창은 숨김
import os from 'node:os';

export const POWERSHELL = 'powershell.exe';

/** 인자: sta 는 클립보드 · 창 다루기처럼 단일 스레드가 필요한 도우미 */
export const psArgs = (rest, { sta = false } = {}) => [...(sta ? ['-STA'] : []), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...rest];

/** spawn · execFile 옵션 */
export const psOptions = (extra = {}) => ({ cwd: os.tmpdir(), windowsHide: true, ...extra });
