// 바탕화면 위젯을 바탕화면 층에 붙이기 (Windows) — Rainmeter 의 "바탕화면에" 처럼
//   위젯 창의 주인(owner)을 바탕화면 창(Progman)으로 바꾸면: 다른 앱 창 뒤에 있고, Win+D(바탕화면 보기)에도 남는다.
//   쓰다가(누르면) 잠깐 앞으로 오고, 다른 데를 누르면 다시 맨 아래로 (bottom).
//   위젯이 "blur" 를 받지 못한 채 앞으로 오는 때가 있어(다른 메모 · 다른 앱을 눌렀을 때, 창을 다시 보일 때 등)
//   PowerToys 처럼 앞 창이 바뀌는 순간(SetWinEventHook)마다 붙여 둔 위젯을 모두 맨 아래로 — 지금 쓰는(앞) 위젯만 빼고.
//   2초마다 한 번 더: 로그인 직후 바탕화면이 늦게 뜨거나 탐색기가 다시 시작돼 주인이 바뀌었으면 새 바탕화면에 다시 붙인다.
//   PowerShell 도우미 하나가 줄 단위 명령을 받는다:  "pin <hwnd>" / "unpin <hwnd>" / "bottom <hwnd>"  →  "ok <hwnd>" | "err <hwnd>"
//   도우미가 없거나(다른 OS) 실패해도 위젯은 그냥 작업 표시줄에 없는 창으로 남는다
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class MkDeskPin {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetOwner(IntPtr h, int index, IntPtr owner);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLongPtr(IntPtr h, int index);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
  const int GWLP_HWNDPARENT = -8;
  const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10;
  const uint EVENT_SYSTEM_FOREGROUND = 3, WM_TIMER = 0x113;
  static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  static readonly object gate = new object();
  static readonly HashSet<long> pinned = new HashSet<long>();
  static WinEventProc keep;

  static bool Own(IntPtr h) {
    IntPtr desk = FindWindow("Progman", null);
    if (desk == IntPtr.Zero) return false;
    if (GetLongPtr(h, GWLP_HWNDPARENT) != desk) SetOwner(h, GWLP_HWNDPARENT, desk);
    return true;
  }
  static void Bottom(IntPtr h) {
    SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  }
  public static string Command(string kind, long w) {
    IntPtr h = new IntPtr(w);
    if (kind == "unpin") { lock (gate) { pinned.Remove(w); } return "ok"; }
    if (!IsWindow(h)) return "err";
    if (kind == "pin") {
      lock (gate) { pinned.Add(w); }
      bool ok = Own(h);
      Bottom(h);
      return ok ? "ok" : "err"; // 바탕화면이 아직 없으면 2초마다 다시 붙여 본다
    }
    if (kind == "bottom") { Bottom(h); return "ok"; }
    return "err";
  }
  // 붙여 둔 위젯을 모두 맨 아래로 (지금 앞 창인 위젯 = 쓰는 중이면 그대로)
  static void KeepDown(bool reown) {
    long[] list;
    lock (gate) { list = new long[pinned.Count]; pinned.CopyTo(list); }
    IntPtr fg = GetForegroundWindow();
    foreach (long w in list) {
      IntPtr h = new IntPtr(w);
      if (!IsWindow(h)) { lock (gate) { pinned.Remove(w); } continue; }
      if (reown) Own(h);
      if (h != fg) Bottom(h);
    }
  }
  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Trim().Split(' ');
      if (p.Length != 2) continue;
      string r = "err";
      try { r = Command(p[0], long.Parse(p[1])); } catch { r = "err"; }
      Console.Out.WriteLine(r + " " + p[1]);
      Console.Out.Flush();
    }
    Environment.Exit(0); // 메모킹이 끝나면 함께
  }
  public static void Run() {
    Thread reader = new Thread(new ThreadStart(ReadCommands));
    reader.IsBackground = true;
    reader.Start();
    keep = new WinEventProc(delegate (IntPtr hook, uint ev, IntPtr hwnd, int o, int c, uint t, uint time) { KeepDown(false); });
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, keep, 0, 0, 0);
    SetTimer(IntPtr.Zero, IntPtr.Zero, 2000, IntPtr.Zero);
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.message == WM_TIMER) KeepDown(true);
      TranslateMessage(ref m);
      DispatchMessage(ref m);
    }
  }
}
'@
[MkDeskPin]::Run()
`;

/** 보낼 명령 한 줄 (잘못된 값이면 null) */
export function pinCommand(kind, hwnd) {
  return (kind === 'pin' || kind === 'unpin' || kind === 'bottom') && Number.isSafeInteger(hwnd) && hwnd > 0 ? `${kind} ${hwnd}` : null;
}

export class DesktopPin {
  constructor({ platform = process.platform } = {}) {
    this.platform = platform;
    this.proc = null;
    this.failed = false;
    this.quickExits = 0; // 띄우자마자 죽은 횟수 (Add-Type 이 막힌 PC 등) — 두 번이면 그만 띄운다
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
    const started = Date.now();
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (/^err /.test(line)) console.warn('바탕화면 위젯을 바탕화면 층에 붙이지 못했어요', line);
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null; // 다음 명령 때 다시 띄운다
      if (Date.now() - started < 10_000 && ++this.quickExits >= 2) this.failed = true; // 늘 죽으면 보통 창으로만
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
