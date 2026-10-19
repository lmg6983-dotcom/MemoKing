// 파일 공유 (Windows) — 내용 단추 › 공유 에서 고른 방법으로
//   drive: Google Drive 에 올리고 링크 복사 (share-drive.js · ipc-handlers.js)
//   mail:  기본 메일 앱(Outlook 등)의 새 메일에 첨부 (MAPI)
//   localsend: LocalSend(오픈소스, 같은 와이파이의 휴대폰 · PC 로 바로 보내기)를 그 파일과 함께 연다
//   (Windows 공유 창은 v0.39.5 에서 뺐다 — 데스크톱 앱에서 띄우는 길이 PC 마다 막혀 믿을 수 없었다)
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 도우미의 대답은 UTF-8 로 (Windows PowerShell 5.1 은 기본이 OEM 코드 페이지라 한국어 오류 문구가 깨진다)
const UTF8_OUT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

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
 *   새 메일은 도우미가 떠 있는 동안만 유지되므로 대답 뒤에도 도우미는 그대로 둔다
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
        cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env }, // cwd: 설치 폴더를 붙잡지 않게 (업데이트)
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
    // 대답이 없으면 도우미를 끈다
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
      const child = spawnApp(exe, [file], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => resolve(`err ${err.message}`));
      child.unref();
      setTimeout(() => resolve('ok'), 300); // 바로 실패하지 않으면 열린 것
    } catch (err) {
      resolve(`err ${err.message}`);
    }
  });
}
