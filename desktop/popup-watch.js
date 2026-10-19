// 팝업 알림 지켜보기 — PowerShell 도우미(scripts/popup-watch.ps1)를 띄워 두고, 읽은 알림 창을 한 줄(JSON)씩 받는다.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';

export class PopupWatcher extends EventEmitter {
  /**
   * @param {{ script: string, dir: string, processes?: string[], onlyPid?: number, forceOcr?: boolean, log?: string }} options
   *   log: 알림 창마다 어떤 방법으로 무엇을 읽었는지 적는 파일 (앱의 알림 창을 어떻게 읽을 수 있는지 보려고)
   */
  constructor({ script, dir, processes = ['KakaoTalk'], onlyPid = 0, forceOcr = false, log = '' }) {
    super();
    Object.assign(this, { script, dir, processes, onlyPid, forceOcr, log });
    this.proc = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  get running() {
    return Boolean(this.proc);
  }

  start() {
    if (this.proc || process.platform !== 'win32') return;
    this.stopping = false;
    fs.mkdirSync(this.dir, { recursive: true });
    const args = ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script,
      '-Dir', this.dir, '-Processes', this.processes.join(',')];
    if (this.onlyPid) args.push('-OnlyPid', String(this.onlyPid));
    if (this.forceOcr) args.push('-ForceOcr');
    if (this.log) args.push('-Log', this.log);
    const proc = spawn('powershell.exe', args, { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); // cwd: 설치 폴더를 작업 폴더로 물려받으면 업데이트 때 그 폴더를 지우지 못한다
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line.replace(/^﻿/, ''));
      } catch {
        return;
      }
      if (msg.error) this.emit('error', new Error(msg.error));
      else this.emit('popup', { ...msg, lines: [].concat(msg.lines ?? []) });
    });
    proc.stderr.on('data', (d) => this.emit('error', new Error(String(d).trim())));
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      // 도우미가 멈추면 잠시 뒤 다시 (끄는 중이 아니면)
      if (!this.stopping) this.restartTimer = setTimeout(() => this.start(), 5000);
    });
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.proc?.kill();
    this.proc = null;
  }
}
