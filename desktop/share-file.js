// 파일 공유 (Windows) — 탐색기에서 파일을 오른쪽 클릭 › 공유 와 같은 Windows 공유 창 (카카오톡 · 메일 · 근처 공유 등)
//   셸의 그 파일 메뉴(IContextMenu)에서 공유 명령("Windows.ModernShare")을 부른다. 공유 창이 그 파일을 넘겨받는 동안
//   도우미(PowerShell)가 살아 있어야 해서 잠시(2분) 기다렸다 끝난다.
//   공유를 부르지 못하면(Windows 10 이전 · 막힌 PC) "err" — 부르는 쪽이 탐색기에서 그 파일을 골라 보여 준다.
import { spawn } from 'node:child_process';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class MkShare {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut);
  [DllImport("shell32.dll")] static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
  [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);

  [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellFolder {
    void ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr eaten, out IntPtr pidl, IntPtr attrs);
    void EnumObjects(IntPtr hwnd, int flags, out IntPtr list);
    void BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    void BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr a, IntPtr b);
    void CreateViewObject(IntPtr hwnd, ref Guid riid, out IntPtr ppv);
    void GetAttributesOf(uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint inOut);
    void GetUIObjectOf(IntPtr hwnd, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref Guid riid, IntPtr reserved, out IntPtr ppv);
  }
  [ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint first, uint last, uint flags);
    [PreserveSig] int InvokeCommand(ref INVOKE info);
    [PreserveSig] int GetCommandString(UIntPtr cmd, uint type, IntPtr reserved, IntPtr name, uint cch);
  }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)]
  struct INVOKE {
    public int cbSize; public uint fMask; public IntPtr hwnd;
    [MarshalAs(UnmanagedType.LPStr)] public string lpVerb;
    public IntPtr lpParameters; public IntPtr lpDirectory; public int nShow; public uint dwHotKey; public IntPtr hIcon; public IntPtr lpTitle;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpVerbW;
    public IntPtr lpParametersW; public IntPtr lpDirectoryW; public IntPtr lpTitleW; public POINT ptInvoke;
  }
  const uint CMIC_MASK_UNICODE = 0x4000, CMIC_MASK_FLAG_NO_UI = 0x400;

  static int Invoke(string file, IntPtr hwnd) {
    IntPtr pidl, parentPtr, child, menuPtr;
    uint sfgao;
    int hr = SHParseDisplayName(file, IntPtr.Zero, out pidl, 0, out sfgao);
    if (hr != 0) return hr;
    try {
      Guid iidFolder = new Guid("000214E6-0000-0000-C000-000000000046");
      hr = SHBindToParent(pidl, ref iidFolder, out parentPtr, out child);
      if (hr != 0) return hr;
      IShellFolder parent = (IShellFolder)Marshal.GetObjectForIUnknown(parentPtr);
      Guid iidMenu = new Guid("000214E4-0000-0000-C000-000000000046");
      parent.GetUIObjectOf(hwnd, 1, new IntPtr[] { child }, ref iidMenu, IntPtr.Zero, out menuPtr);
      IContextMenu menu = (IContextMenu)Marshal.GetObjectForIUnknown(menuPtr);
      IntPtr hmenu = CreatePopupMenu();
      try {
        menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, 0); // 메뉴를 만들어야 공유 같은 추가 명령이 준비된다
        INVOKE info = new INVOKE();
        info.cbSize = Marshal.SizeOf(typeof(INVOKE));
        info.fMask = CMIC_MASK_UNICODE | CMIC_MASK_FLAG_NO_UI;
        info.hwnd = hwnd;
        info.lpVerb = "Windows.ModernShare";
        info.lpVerbW = "Windows.ModernShare";
        info.nShow = 1;
        return menu.InvokeCommand(ref info);
      } finally { DestroyMenu(hmenu); }
    } finally { CoTaskMemFree(pidl); }
  }
  public static string Run(string file, long hwnd) {
    int hr = Invoke(file, new IntPtr(hwnd));
    if (hr != 0 && hwnd != 0) hr = Invoke(file, IntPtr.Zero); // 다른 프로그램의 창에 붙이지 못하면 창 없이
    return hr == 0 ? "ok" : "err " + hr.ToString("X8");
  }
  // 공유 창이 파일을 넘겨받는 동안 기다린다 (메시지를 돌리며)
  public static void Wait(int ms) {
    DateTime end = DateTime.Now.AddMilliseconds(ms);
    MSG m;
    while (DateTime.Now < end) {
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }
      Thread.Sleep(50);
    }
  }
}
'@
$r = [MkShare]::Run($env:MK_SHARE_FILE, [long]$env:MK_SHARE_HWND)
[Console]::Out.WriteLine($r)
[Console]::Out.Flush()
if ($r -eq 'ok') { [MkShare]::Wait(120000) }
`;

/**
 * Windows 공유 창을 띄운다 → 'ok' | 'unavailable' | 'err'
 * @param {string} file 절대 경로
 * @param {number} hwnd 공유 창을 붙일 창 (0 이면 창 없이)
 */
export function shareFile(file, hwnd = 0, { platform = process.platform, spawnHelper = spawn, timeoutMs = 15_000 } = {}) {
  if (platform !== 'win32') return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let proc;
    try {
      proc = spawnHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, MK_SHARE_FILE: file, MK_SHARE_HWND: String(Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : 0) },
      });
    } catch {
      return finish('err');
    }
    let out = '';
    proc.stdout.on('data', (b) => {
      out += b;
      if (/\n/.test(out)) finish(/^ok\b/.test(out.trim()) ? 'ok' : 'err');
    });
    proc.on('error', () => finish('err'));
    proc.on('exit', () => finish(/^ok\b/.test(out.trim()) ? 'ok' : 'err'));
    setTimeout(() => finish('err'), timeoutMs); // 도우미가 대답이 없으면 (그래도 뒤에 뜰 수는 있다)
  });
}
