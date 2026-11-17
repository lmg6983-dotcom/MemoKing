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
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr h, IntPtr id, uint ms, IntPtr fn);
  const int GWLP_HWNDPARENT = -8;
  const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOACTIVATE = 0x10;
  const uint EVENT_SYSTEM_FOREGROUND = 3, WM_TIMER = 0x113, GW_OWNER = 4;
  static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  static readonly object gate = new object();
  static readonly HashSet<long> pinned = new HashSet<long>();
  // 붙여 둔 창 → 그 창 위 가장자리의 테이프 창 (메모 창을 맨 아래로 보낼 때 테이프도 바로 위에 함께 — 다른 창 위에 남거나 메모 뒤로 가지 않게)
  static readonly Dictionary<long, long> companions = new Dictionary<long, long>();
  static WinEventProc keep;

  static bool Own(IntPtr h) {
    IntPtr desk = FindWindow("Progman", null);
    if (desk == IntPtr.Zero) return false;
    if (GetLongPtr(h, GWLP_HWNDPARENT) != desk) SetOwner(h, GWLP_HWNDPARENT, desk);
    return true;
  }
  static void Bottom(IntPtr h) {
    long c = 0;
    lock (gate) { companions.TryGetValue(h.ToInt64(), out c); }
    IntPtr ch = new IntPtr(c);
    // 테이프를 먼저 맨 아래로, 그다음 메모 창을 그 아래로 → 테이프는 늘 메모 창 바로 위
    if (c != 0 && IsWindow(ch)) SetWindowPos(ch, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    SetWindowPos(h, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  }
  public static string Pair(long w, long c) {
    lock (gate) {
      if (c == 0) companions.Remove(w);
      else companions[w] = c;
    }
    return "ok";
  }
  public static string Command(string kind, long w) {
    IntPtr h = new IntPtr(w);
    if (kind == "unpin") {
      lock (gate) { pinned.Remove(w); companions.Remove(w); }
      // 보통 창으로: 주인이 바탕화면이면 없음으로 (메모 창은 원래 주인이 없다)
      if (IsWindow(h)) {
        IntPtr desk = FindWindow("Progman", null);
        if (desk != IntPtr.Zero && GetLongPtr(h, GWLP_HWNDPARENT) == desk) SetOwner(h, GWLP_HWNDPARENT, IntPtr.Zero);
      }
      return "ok";
    }
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
  // 앞 창이 h 이거나 h가 띄운 창(대화 상자 · 메뉴)인가 — 주인을 거슬러 올라가 본다 (바탕화면에서 멈춤)
  static bool InUse(IntPtr h, IntPtr fg) {
    for (int i = 0; fg != IntPtr.Zero && i < 8; i++) {
      if (fg == h) return true;
      fg = GetWindow(fg, GW_OWNER);
    }
    return false;
  }
  // 앞 창이 바뀌면(down) 붙여 둔 창을 모두 맨 아래로 (쓰는 중인 창은 그대로). 2초 확인(down 아님)은 주인만 다시 붙인다
  static void KeepDown(bool down) {
    long[] list;
    lock (gate) { list = new long[pinned.Count]; pinned.CopyTo(list); }
    IntPtr fg = GetForegroundWindow();
    foreach (long w in list) {
      IntPtr h = new IntPtr(w);
      if (!IsWindow(h)) { lock (gate) { pinned.Remove(w); companions.Remove(w); } continue; }
      if (!down) { Own(h); continue; }
      if (!InUse(h, fg)) Bottom(h);
    }
  }
  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Trim().Split(' ');
      if (p.Length != 2 && !(p.Length == 3 && p[0] == "pair")) continue;
      string r = "err";
      try { r = p.Length == 3 ? Pair(long.Parse(p[1]), long.Parse(p[2])) : Command(p[0], long.Parse(p[1])); } catch { r = "err"; }
      Console.Out.WriteLine(r + " " + p[1]);
      Console.Out.Flush();
    }
    Environment.Exit(0); // 메모킹이 끝나면 함께
  }
  public static void Run() {
    Thread reader = new Thread(new ThreadStart(ReadCommands));
    reader.IsBackground = true;
    reader.Start();
    keep = new WinEventProc(delegate (IntPtr hook, uint ev, IntPtr hwnd, int o, int c, uint t, uint time) { KeepDown(true); });
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, keep, 0, 0, 0);
    SetTimer(IntPtr.Zero, IntPtr.Zero, 2000, IntPtr.Zero);
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.message == WM_TIMER) KeepDown(false);
      TranslateMessage(ref m);
      DispatchMessage(ref m);
    }
  }
}
'@
[MkDeskPin]::Run()
