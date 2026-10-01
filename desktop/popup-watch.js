// 팝업 알림 지켜보기 — PowerShell 도우미(scripts/popup-watch.ps1)를 띄워 두고, 읽은 알림 창을 한 줄(JSON)씩 받는다.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export class PopupWatcher extends EventEmitter {
  /**
   * @param {{ script: string, dir: string, processes?: string[], onlyPid?: number, forceOcr?: boolean }} options
   */
  constructor({ script, dir, processes = ['KakaoTalk'], onlyPid = 0, forceOcr = false }) {
    super();
    Object.assign(this, { script, dir, processes, onlyPid, forceOcr });
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
    const proc = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
