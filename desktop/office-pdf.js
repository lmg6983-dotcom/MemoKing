// Word · PowerPoint 문서 → PDF (이 PC 에 설치된 Office 로) — 메모에 장마다 그림으로 넣을 때 화면에서 흉내 내 그린 것(그림 깨짐 · 장 나눔 틀림) 대신
//   Office 가 없거나 실패하면 null → 화면이 예전처럼 직접 그린다
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POWERSHELL, psArgs, psOptions } from './powershell.js';

export const OFFICE_PDF_EXT = /\.(docx|pptx)$/i;

// 경로는 환경 변수로 넘긴다 (명령 줄에 끼우면 따옴표 · 특수 문자가 섞인다)
// 사용자가 이미 띄워 둔 PowerPoint 에 붙는 경우(PowerPoint 는 한 개만 뜬다) 사용자의 창은 닫지 않는다
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = $env:MK_SRC; $out = $env:MK_OUT
if ($src -match '\\.pptx$') {
  $running = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $doc = $app.Presentations.Open($src, -1, 0, 0)
    try { $doc.SaveAs($out, 32) } finally { $doc.Close() }
  } finally { if (-not $running -and $app.Presentations.Count -eq 0) { $app.Quit() } }
} else {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false; $app.DisplayAlerts = 0
  try {
    $doc = $app.Documents.Open($src, $false, $true, $false, 'mk-no-password')
    try { $doc.ExportAsFixedFormat($out, 17) } finally { $doc.Close(0) }
  } finally { if ($app.Documents.Count -eq 0) { $app.Quit() } }
}
`;

/** @returns {Promise<Uint8Array|null>} PDF 내용 (Windows 가 아니거나 Office 가 없거나 실패하면 null) */
export function officeToPdf(src) {
  if (process.platform !== 'win32' || !OFFICE_PDF_EXT.test(src)) return Promise.resolve(null);
  const out = path.join(os.tmpdir(), `memoking-pdf-${Date.now()}-${process.hrtime.bigint() % 10000n}.pdf`);
  return new Promise((resolve) => {
    // shortcut: 암호 걸린 PowerPoint 처럼 Office 가 물어보며 멈추면 90초 뒤 포기 (Office 프로그램은 남을 수 있음)
    execFile(POWERSHELL, psArgs(['-Command', SCRIPT]), psOptions({ timeout: 90_000, env: { ...process.env, MK_SRC: src, MK_OUT: out } }), (err, _stdout, stderr) => {
      let pdf = null;
      try {
        if (!err && fs.existsSync(out)) pdf = new Uint8Array(fs.readFileSync(out));
        else console.warn('[Office PDF]', path.basename(src), String(stderr || err?.message || '').trim().slice(0, 300));
      } finally {
        fs.rmSync(out, { force: true });
      }
      resolve(pdf);
    });
  });
}
