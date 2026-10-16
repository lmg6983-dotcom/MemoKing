// 파일 공유 (Windows) — 내용 단추 › 공유 에서 고른 방법으로
//   sheet: Windows 공유 창 (근처 공유 · Quick Share · 메일 · 카카오톡 등 공유를 받는 앱)
//          데스크톱 앱용 공식 API(DataTransferManager · IDataTransferManagerInterop)로 띄운다. 공유 창은 그것을 부른
//          프로세스의 창에만 붙으므로 도우미(PowerShell)가 화면 가운데에 보이지 않는 작은 창을 만들어 거기에 띄운다.
//          (예전 방식 — 탐색기 오른쪽 클릭 메뉴의 공유 명령을 다른 프로세스에서 부르기 — 은 탐색기 밖에서 자주 실패했다)
//   mail:  기본 메일 앱(Outlook 등)의 새 메일에 첨부 (MAPI)
//   localsend: LocalSend(오픈소스, 같은 와이파이의 휴대폰 · PC 로 바로 보내기)를 그 파일과 함께 연다
//   도우미가 실패하면 그 까닭을 돌려준다 (부르는 쪽이 안내하고, 공유 창이면 탐색기에서 파일을 골라 둔다)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------- Windows 공유 창 ----------
// 도우미의 대답은 UTF-8 로 (Windows PowerShell 5.1 은 기본이 OEM 코드 페이지라 한국어 오류 문구가 깨진다)
const UTF8_OUT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

const SHEET_SCRIPT = `
$ErrorActionPreference = 'Stop'
${UTF8_OUT}
try {
  Add-Type -AssemblyName System.Windows.Forms
  $fw = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $wm = Join-Path $env:SystemRoot 'System32\\WinMetadata'
  $refs = @(
    (Join-Path $fw 'System.Runtime.WindowsRuntime.dll'), (Join-Path $fw 'System.Runtime.dll'),
    (Join-Path $fw 'System.Runtime.InteropServices.WindowsRuntime.dll'), (Join-Path $fw 'System.Windows.Forms.dll'),
    (Join-Path $wm 'Windows.ApplicationModel.winmd'), (Join-Path $wm 'Windows.Foundation.winmd'), (Join-Path $wm 'Windows.Storage.winmd')
  )
  Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Windows.Forms;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

public static class MkShareSheet {
  [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDataTransferManagerInterop {
    IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
    void ShowShareUIForWindow(IntPtr appWindow);
  }
  public static string Run(string file, string title) {
    Form form = new Form();
    form.FormBorderStyle = FormBorderStyle.None;
    form.ShowInTaskbar = false;
    form.StartPosition = FormStartPosition.CenterScreen;
    form.Size = new System.Drawing.Size(1, 1);
    form.Opacity = 0.01;
    form.TopMost = true;
    string result = "err show";
    form.Shown += delegate {
      try {
        IDataTransferManagerInterop interop = (IDataTransferManagerInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(DataTransferManager));
        Guid iid = new Guid("a5caee9b-8708-49d1-8d36-67d25a8da00c");
        DataTransferManager dtm = (DataTransferManager)Marshal.GetObjectForIUnknown(interop.GetForWindow(form.Handle, ref iid));
        dtm.DataRequested += delegate (DataTransferManager s, DataRequestedEventArgs e) {
          DataRequestDeferral wait = e.Request.GetDeferral();
          e.Request.Data.Properties.Title = title;
          StorageFile.GetFileFromPathAsync(file).AsTask().ContinueWith(t => {
            try {
              if (t.Status == System.Threading.Tasks.TaskStatus.RanToCompletion) e.Request.Data.SetStorageItems(new List<IStorageItem> { t.Result });
              else e.Request.FailWithDisplayText("파일을 열지 못했어요");
            } finally { wait.Complete(); }
          });
        };
        interop.ShowShareUIForWindow(form.Handle);
        result = "ok";
        Console.Out.WriteLine("ok");
        Console.Out.Flush();
      } catch (Exception ex) {
        result = "err " + ex.GetType().Name + ": " + ex.Message;
        form.Close();
      }
    };
    // 공유 창이 파일을 넘겨받는 동안 이 창(과 도우미)이 살아 있어야 한다 — 2분 뒤 닫힘
    Timer t2 = new Timer();
    t2.Interval = 120000;
    t2.Tick += delegate { t2.Stop(); form.Close(); };
    t2.Start();
    Application.Run(form);
    return result;
  }
}
'@
  $r = [MkShareSheet]::Run($env:MK_SHARE_FILE, $env:MK_SHARE_TITLE)
  if ($r -ne 'ok') { [Console]::Out.WriteLine($r) }
} catch {
  [Console]::Out.WriteLine('err ' + $_.Exception.Message)
}
`;

// ---------- 메일에 첨부 (MAPI — 기본 메일 앱) ----------
const MAIL_SCRIPT = `
$ErrorActionPreference = 'Stop'
${UTF8_OUT}
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MkMail {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiFileDescW { public int reserved; public int flags; public int position = -1; public string pathName; public string fileName; public IntPtr fileType; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class MapiMessageW {
    public int reserved; public string subject; public string noteText; public string messageType; public string dateReceived; public string conversationID;
    public int flags; public IntPtr originator; public int recipCount; public IntPtr recips; public int fileCount; public IntPtr files;
  }
  [DllImport("mapi32.dll", CharSet = CharSet.Unicode)]
  static extern int MAPISendMailW(IntPtr session, IntPtr hwnd, MapiMessageW message, int flags, int reserved);
  public static int Send(string file, string subject) {
    MapiFileDescW f = new MapiFileDescW();
    f.pathName = file;
    f.fileName = System.IO.Path.GetFileName(file);
    IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(f));
    try {
      Marshal.StructureToPtr(f, p, false);
      MapiMessageW m = new MapiMessageW();
      m.subject = subject;
      m.noteText = "";
      m.fileCount = 1;
      m.files = p;
      // MAPI_DIALOG | MAPI_DIALOG_MODELESS | MAPI_LOGON_UI — 새 메일 창을 띄우고 바로 돌아온다 (다 쓸 때까지 기다리지 않음)
      return MAPISendMailW(IntPtr.Zero, IntPtr.Zero, m, 0x8 | 0x4 | 0x1, 0);
    } finally { Marshal.FreeHGlobal(p); }
  }
}
'@
  $code = [MkMail]::Send($env:MK_SHARE_FILE, $env:MK_SHARE_TITLE)
  # 0 보냄 · 1 사용자가 닫음 → 둘 다 잘 된 것
  if ($code -eq 0 -or $code -eq 1) { [Console]::Out.WriteLine('ok') } else { [Console]::Out.WriteLine('err mapi ' + $code) }
} catch {
  [Console]::Out.WriteLine('err ' + $_.Exception.Message)
}
`;

/**
 * 도우미(PowerShell)를 띄워 첫 줄의 대답을 기다린다 → 'ok' | 'err …'
 *   공유 창 · 새 메일은 도우미가 떠 있는 동안만 유지되므로 대답 뒤에도 도우미는 그대로 둔다
 */
export function runHelper(script, env, { platform = process.platform, spawnHelper = spawn, timeoutMs = 20_000 } = {}) {
  if (platform !== 'win32') return Promise.resolve('err unavailable');
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    let timer = 0;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const text = () => Buffer.concat(chunks).toString('utf8'); // 조각마다 바꾸면 한글이 반으로 잘릴 수 있다
    let proc;
    try {
      proc = spawnHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env },
      });
    } catch (err) {
      return finish(`err ${err.message}`);
    }
    proc.stdout.on('data', (b) => {
      chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)));
      const out = text();
      const line = out.split(/\r?\n/).find((l) => l.trim());
      if (/\n/.test(out) && line) finish(/^ok\b/.test(line.trim()) ? 'ok' : line.trim());
    });
    proc.on('error', (err) => finish(`err ${err.message}`));
    proc.on('exit', () => finish(/^ok\b/.test(text().trim()) ? 'ok' : (text().trim() || 'err exit')));
    // 대답이 없으면 도우미를 끈다 (늦게라도 공유 창이 떠 탐색기 대신 보여 준 것과 겹치지 않게)
    timer = setTimeout(() => {
      if (done) return;
      try {
        proc.kill();
      } catch {
        // 이미 끝남
      }
      finish('err timeout');
    }, timeoutMs);
  });
}

/** Windows 공유 창 → 'ok' | 'err …' */
export function shareSheet(file, title = '', opts) {
  return runHelper(SHEET_SCRIPT, { MK_SHARE_FILE: file, MK_SHARE_TITLE: title || path.basename(file) }, opts);
}

/** 기본 메일 앱의 새 메일에 첨부 → 'ok' | 'err …' (메일 앱이 없으면 'err mapi …') */
export function mailAttach(file, title = '', opts) {
  return runHelper(MAIL_SCRIPT, { MK_SHARE_FILE: file, MK_SHARE_TITLE: title || path.basename(file) }, { timeoutMs: 60_000, ...opts });
}

// ---------- LocalSend ----------
export const LOCALSEND_DOWNLOAD = 'https://localsend.org/download';

/** 설치된 LocalSend 실행 파일 (없으면 null) — 설치판 · 사용자 설치 · 휴대용(Scoop · winget 링크) 자리를 본다 */
export function findLocalSend({ env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const join = path.win32.join;
  const places = [
    env.ProgramFiles && join(env.ProgramFiles, 'LocalSend', 'localsend_app.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'LocalSend', 'localsend_app.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'LocalSend', 'localsend_app.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'LocalSend', 'localsend_app.exe'),
    env.USERPROFILE && join(env.USERPROFILE, 'scoop', 'apps', 'localsend', 'current', 'localsend_app.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'localsend_app.exe'),
  ].filter(Boolean);
  return places.find((p) => exists(p)) ?? null;
}

/** LocalSend 를 그 파일과 함께 연다 → 'ok' | 'missing' | 'err …' */
export function openLocalSend(file, { exe = findLocalSend(), spawnApp = spawn } = {}) {
  if (!exe) return Promise.resolve('missing');
  return new Promise((resolve) => {
    try {
      const child = spawnApp(exe, [file], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => resolve(`err ${err.message}`));
      child.unref();
      setTimeout(() => resolve('ok'), 300); // 바로 실패하지 않으면 열린 것
    } catch (err) {
      resolve(`err ${err.message}`);
    }
  });
}
