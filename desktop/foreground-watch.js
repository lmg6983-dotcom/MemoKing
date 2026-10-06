// 왕관 스티커(늘 위에 두기)를 지키는 감시 (Windows) — 스티커를 붙인 창이 있을 때만 돈다.
//   1) Windows 가 메모킹 창의 "늘 위"를 몰래 풀어 버리는 일이 있다 (Electron 은 켜 둔 줄로만 안다 → 브라우저 아래로 내려감).
//      1초마다 실제 상태(WS_EX_TOPMOST)를 보고, 풀렸으면 알린다 → 다시 켠다.
//   2) 다른 프로그램도 "늘 위" 창을 쓰면(브라우저 동영상 작은 창 등) 나중에 앞으로 온 쪽이 위에 간다.
//      그런 창이 앞으로 오는 순간에만 메모킹 창을 다시 맨 위로 (메뉴·캡처 화면·시작 메뉴는 덮지 않게 그 밖의 때는 가만히).
//   PowerShell 도우미가 알린다 (한 줄씩):  "fg <hwnd> <늘 위 0|1> <프로그램 이름>"  /  "lost <hwnd>"
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// 앞으로 와도 메모킹 창을 올리지 않는 프로그램 — 캡처·시작 메뉴·검색·작업 전환·화상 키보드·작업 관리자 등
export const LEAVE_ON_TOP = new Set([
  'screenclippinghost', 'snippingtool', 'screensketch', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost',
  'searchapp', 'searchui', 'explorer', 'lockapp', 'textinputhost', 'magnify', 'osk', 'taskmgr', 'sharex', 'greenshot',
  'lightshot', 'picpick', 'obs64', 'memoking', 'electron', 'applicationframehost', 'widgets', 'shellhost',
]);

// PowerToys "Always On Top" 처럼: 폴링 대신 Windows 이벤트 훅(SetWinEventHook)으로 앞 창이 바뀌는 순간을 바로 받고,
// 1초 타이머로 지키는 창의 실제 WS_EX_TOPMOST 를 확인한다 (메시지 루프는 도우미 안에서)
function script(watch) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class MkTopWatch {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  const uint EVENT_SYSTEM_FOREGROUND = 3, EVENT_SYSTEM_MINIMIZEEND = 0x17, WM_TIMER = 0x113;
  static WinEventProc keep;
  static long[] watched;
  static bool Topmost(IntPtr h) { return (GetWindowLong(h, -20) & 8) != 0; }
  static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != 0 || hwnd == IntPtr.Zero) return;
    if (ev == EVENT_SYSTEM_FOREGROUND) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      string name = "";
      try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
      Say("fg " + hwnd.ToInt64() + " " + (Topmost(hwnd) ? 1 : 0) + " " + name);
    } else if (ev == EVENT_SYSTEM_MINIMIZEEND) {
      Check();
    }
  }
  static void Check() {
    foreach (long w in watched) {
      IntPtr h = new IntPtr(w);
      if (IsWindowVisible(h) && !IsIconic(h) && !Topmost(h)) Say("lost " + w);
    }
  }
  public static void Run(long[] watch) {
    watched = watch;
    keep = OnEvent;
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, keep, 0, 0, 0);
    SetWinEventHook(EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, keep, 0, 0, 0);
    SetTimer(IntPtr.Zero, IntPtr.Zero, 1000, IntPtr.Zero);
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.message == WM_TIMER) Check();
      TranslateMessage(ref m);
      DispatchMessage(ref m);
    }
  }
}
'@
[MkTopWatch]::Run([long[]]@(${watch.join(', ')}))
`;
}

/** 도우미가 알린 한 줄 → { type: 'fg', hwnd, topmost, name } | { type: 'lost', hwnd } | null */
export function parseLine(line) {
  const m = String(line ?? '').trim().match(/^(fg|lost) (\d+)(?: ([01]) ?(.*))?$/);
  if (!m) return null;
  const hwnd = Number(m[2]);
  if (!hwnd) return null;
  return m[1] === 'lost' ? { type: 'lost', hwnd } : { type: 'fg', hwnd, topmost: m[3] === '1', name: (m[4] ?? '').trim().toLowerCase() };
}

export class ForegroundWatch {
  /** @param {{ onEvent: (e: ReturnType<typeof parseLine>) => void }} opts */
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.proc = null;
    this.watch = [];
    this.retry = null;
  }

  get running() {
    return Boolean(this.proc);
  }

  /** 지킬 창들(HWND)로 (다시) 시작 — 비면 멈춘다 */
  update(hwnds) {
    const next = [...new Set(hwnds.filter(Boolean))].sort();
    if (this.proc && next.join() === this.watch.join()) return;
    this.stop();
    this.watch = next;
    if (next.length) this.start();
  }

  start() {
    if (this.proc || process.platform !== 'win32' || !this.watch.length) return;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script(this.watch)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      const e = parseLine(line);
      if (e) this.onEvent(e);
    });
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      // 도우미가 멈췄는데 아직 지킬 창이 있으면 잠시 뒤 다시
      this.retry = setTimeout(() => this.start(), 3000);
    });
    proc.on('error', () => {});
  }

  stop() {
    clearTimeout(this.retry);
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) proc.kill();
  }
}

/** BrowserWindow 의 HWND 를 숫자로 */
export function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
  } catch {
    return 0;
  }
}
