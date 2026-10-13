// 바탕화면 위젯을 바탕화면 층에 붙이기 (Windows) — Rainmeter 의 "바탕화면에" 처럼
//   위젯 창의 주인(owner)을 바탕화면 창(Progman)으로 바꾸면: 다른 앱 창 뒤에 있고, Win+D(바탕화면 보기)에도 남는다.
//   쓰다가(누르면) 잠깐 앞으로 오고, 다른 데를 누르면 다시 맨 아래로 (bottom).
//   PowerShell 도우미 하나가 줄 단위 명령을 받는다:  "pin <hwnd>"  /  "bottom <hwnd>"  →  "ok <hwnd>" | "err <hwnd>"
//   도우미가 없거나(다른 OS) 실패해도 위젯은 그냥 작업 표시줄에 없는 창으로 남는다
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MkDeskPin {
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetOwner(IntPtr h, int index, IntPtr owner);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  const int GWLP_HWNDPARENT = -8;
  const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10;
  static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public static string Pin(long w) {
    IntPtr h = new IntPtr(w);
    IntPtr desk = FindWindow("Progman", null);
    if (!IsWindow(h) || desk == IntPtr.Zero) return "err";
    SetOwner(h, GWLP_HWNDPARENT, desk);
    SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    return "ok";
  }
  public static string Bottom(long w) {
    IntPtr h = new IntPtr(w);
    if (!IsWindow(h)) return "err";
    SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    return "ok";
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Trim().Split(' ')
  if ($p.Length -ne 2) { continue }
  $r = 'err'
  try {
    if ($p[0] -eq 'pin') { $r = [MkDeskPin]::Pin([long]$p[1]) }
    elseif ($p[0] -eq 'bottom') { $r = [MkDeskPin]::Bottom([long]$p[1]) }
  } catch { $r = 'err' }
  [Console]::Out.WriteLine("$r $($p[1])")
  [Console]::Out.Flush()
}
`;

/** 보낼 명령 한 줄 (잘못된 값이면 null) */
export function pinCommand(kind, hwnd) {
  return (kind === 'pin' || kind === 'bottom') && Number.isSafeInteger(hwnd) && hwnd > 0 ? `${kind} ${hwnd}` : null;
}

export class DesktopPin {
  constructor({ platform = process.platform } = {}) {
    this.platform = platform;
    this.proc = null;
    this.failed = false;
  }

  get available() {
    return this.platform === 'win32' && !this.failed;
  }

  send(kind, hwnd) {
    const line = pinCommand(kind, hwnd);
    if (!line || !this.available) return false;
    this.start();
    try {
      this.proc?.stdin.write(`${line}\n`);
      return true;
    } catch {
      return false;
    }
  }

  start() {
    if (this.proc || !this.available) return;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (/^err /.test(line)) console.warn('바탕화면 위젯을 바탕화면 층에 붙이지 못했어요', line);
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null; // 다음 명령 때 다시 띄운다
    });
    proc.on('error', () => {
      this.failed = true; // PowerShell 이 없으면 그냥 보통 창으로
      if (this.proc === proc) this.proc = null;
    });
    proc.stdin.on('error', () => {});
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) proc.kill();
  }
}
