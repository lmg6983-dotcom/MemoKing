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
[MkTopWatch]::Run([long[]]@({WATCH}))
