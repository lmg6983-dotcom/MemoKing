// 왕관 스티커(늘 위에 두기)를 지키는 감시 (Windows) — 스티커를 붙인 창이 있을 때만 돈다.
//   1) Windows 가 메모킹 창의 "늘 위"를 몰래 풀어 버리는 일이 있다 (Electron 은 켜 둔 줄로만 안다 → 브라우저 아래로 내려감).
//      1초마다 실제 상태(WS_EX_TOPMOST)를 보고, 풀렸으면 알린다 → 다시 켠다.
//   2) 다른 프로그램도 "늘 위" 창을 쓰면(브라우저 동영상 작은 창 등) 나중에 앞으로 온 쪽이 위에 간다.
//      그런 창이 앞으로 오는 순간에만 메모킹 창을 다시 맨 위로 (메뉴·캡처 화면·시작 메뉴는 덮지 않게 그 밖의 때는 가만히).
//   PowerShell 도우미가 0.25초마다 앞 창을 보고 한 줄씩 알린다:  "fg <hwnd> <늘 위 0|1> <프로그램 이름>"  /  "lost <hwnd>"
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// 앞으로 와도 메모킹 창을 올리지 않는 프로그램 — 캡처·시작 메뉴·검색·작업 전환·화상 키보드·작업 관리자 등
export const LEAVE_ON_TOP = new Set([
  'screenclippinghost', 'snippingtool', 'screensketch', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost',
  'searchapp', 'searchui', 'explorer', 'lockapp', 'textinputhost', 'magnify', 'osk', 'taskmgr', 'sharex', 'greenshot',
  'lightshot', 'picpick', 'obs64', 'memoking', 'electron', 'applicationframehost', 'widgets', 'shellhost',
]);

function script(watch) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace MkFg -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h, int i);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint procId);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
'@
$watch = @(${watch.map((h) => `[System.IntPtr]::new([long]${h})`).join(', ')})
$last = [System.IntPtr]::Zero
$tick = 0
while ($true) {
  $h = [MkFg.W]::GetForegroundWindow()
  if ($h -ne $last -and $h -ne [System.IntPtr]::Zero) {
    $last = $h
    $top = [int](([MkFg.W]::GetWindowLong($h, -20) -band 8) -ne 0)
    $procId = [uint32]0
    [void][MkFg.W]::GetWindowThreadProcessId($h, [ref]$procId)
    $name = ''
    try { $name = (Get-Process -Id $procId).ProcessName } catch {}
    [Console]::Out.WriteLine("fg $($h.ToInt64()) $top $name")
  }
  if (($tick % 4) -eq 0) {
    foreach ($w in $watch) {
      if ([MkFg.W]::IsWindowVisible($w) -and -not [MkFg.W]::IsIconic($w) -and (([MkFg.W]::GetWindowLong($w, -20) -band 8) -eq 0)) {
        [Console]::Out.WriteLine("lost $($w.ToInt64())")
      }
    }
  }
  [Console]::Out.Flush()
  $tick++
  Start-Sleep -Milliseconds 250
}
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
