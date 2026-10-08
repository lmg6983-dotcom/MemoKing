// 빠른 메모 (Ctrl+Alt+C) — 어느 앱에서든 선택한 것(글·파일·그림)을 복사해 새 메모로 만든다.
//
// 1) 전역 단축키가 눌리면 PowerShell 도우미(상주)가 사용자가 키에서 손을 뗄 때까지 기다렸다가
//    앞에 있는 창에 Ctrl+C 를 보내고, 클립보드가 바뀌면 그 내용을 임시 폴더에 풀어 둔다.
// 2) 여기서 그 폴더를 읽어 파일·그림은 메모 폴더(attachments)로 옮기고, 글은 메모 창의 붙여넣기로 넘긴다.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { parseCfHtml, htmlHasText } from '../app/js/core/clipboard-html.js';
import { mediaKindOf } from '../app/js/core/memo-file.js';

// ---------- 상주 도우미 ----------

export class CaptureHelper {
  constructor(scriptPath) {
    this.scriptPath = scriptPath;
    this.proc = null;
    this.ready = null;
    this.waiting = [];
  }

  start() {
    if (this.proc) return this.ready;
    const proc = spawn('powershell.exe', [
      '-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Action', 'serve',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let markReady;
    this.ready = new Promise((resolve) => (markReady = resolve));
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line.replace(/^﻿/, ''));
      } catch {
        return; // 도우미가 찍는 다른 출력은 무시
      }
      if (msg.ready) return markReady(true);
      this.waiting.shift()?.resolve(msg);
    });
    proc.stderr.on('data', (d) => console.warn('[빠른 메모 도우미]', String(d).trim()));
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      markReady(false);
      for (const w of this.waiting.splice(0)) w.reject(new Error('도우미가 꺼졌어요'));
    });
    return this.ready;
  }

  async request(line, timeout = 10_000) {
    if (!this.proc) this.start();
    if (!(await this.ready)) throw new Error('도우미를 시작하지 못했습니다');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error('도우미 응답 시간 초과'));
      }, timeout);
      const entry = {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.waiting.push(entry);
      this.proc.stdin.write(`${line}\n`);
    });
  }

  /** @returns {Promise<{ changed: boolean, window: string, process: string, files: boolean, text: boolean, html: boolean, image: boolean, error?: string }>} */
  // onlyPid: 맨 앞 창이 이 프로세스일 때만 Ctrl+C 를 보낸다 (자동 점검용 안전장치)
  capture(dir, { copy = true, onlyPid = 0 } = {}) {
    const encoded = Buffer.from(dir, 'utf8').toString('base64');
    const mode = !copy ? '\tnocopy' : onlyPid ? `\tonly:${onlyPid}` : '';
    return this.request(`capture\t${encoded}${mode}`);
  }

  stop() {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
  }
}

// ---------- 풀어 둔 클립보드 → 메모 내용 ----------

export function readCaptureDir(dir) {
  const read = (name, enc) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, enc) : null;
  };
  const files = (read('files.txt', 'utf8') ?? '').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const cf = read('html.bin');
  const { html, sourceUrl } = cf ? parseCfHtml(new Uint8Array(cf)) : { html: null, sourceUrl: null };
  const image = fs.existsSync(path.join(dir, 'image.png')) ? path.join(dir, 'image.png') : null;
  return { files, text: read('text.txt', 'utf8')?.replace(/^﻿/, '') ?? '', html, sourceUrl, image };
}

const VIDEO_EXT = /\.(mp4|m4v|mov|ogv|mkv|webm)$/i;

/**
 * 메모 창에 넘길 내용. 파일·그림은 여기서 메모 폴더에 저장한다.
 * @returns {{ heading: string|null, html: string|null, text: string|null, items: object[], source: object, skipped: string[] } | null}
 */
export function buildCapture(dump, info, vault, now = new Date()) {
  const items = [];
  const skipped = [];
  let heading = null;
  let html = null;
  let text = null;

  if (dump.files.length) {
    // 탐색기·바탕화면에서 복사한 파일
    for (const file of dump.files) {
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        // 없는 파일
      }
      if (!stat?.isFile()) {
        skipped.push(path.basename(file));
        continue;
      }
      const name = path.basename(file);
      const base = name.replace(/\.[^.]+$/, '');
      const src = vault.copyAttachment(file);
      const alt = VIDEO_EXT.test(name) ? `동영상 ${base}` : base;
      const kind = mediaKindOf(src, alt);
      items.push(kind ? { kind, src, alt } : { kind: 'file', src, name });
    }
    if (items.length) heading = items.length === 1 ? path.basename(dump.files[0]) : `${path.basename(dump.files[0])} 외 ${items.length - 1}개`;
  } else if (dump.image && !(dump.html && htmlHasText(dump.html))) {
    // 그림 (화면 캡처, 그림 편집기, 브라우저 "이미지 복사")
    items.push({ kind: 'image', src: vault.saveAttachment(fs.readFileSync(dump.image), 'png'), alt: '캡처한 그림' });
    heading = '캡처한 그림';
  } else if (dump.html && htmlHasText(dump.html)) {
    html = dump.html; // 웹·워드: 메모 창의 붙여넣기(서식·사진 저장)로 처리
    text = dump.text;
  } else if (dump.text.trim()) {
    text = dump.text;
  }

  if (!items.length && !html && !text) return null;
  return {
    heading,
    html,
    text,
    items,
    skipped,
    source: { window: info.window ?? '', process: info.process ?? '', url: dump.sourceUrl, time: now.toISOString(), copied: Boolean(info.changed) },
  };
}

// 알림에 보여줄 메모 제목 — 파일·그림은 제목, 글은 첫 줄 (메모 창이 채우기 전에 미리 알 수 있게)
export function captureTitle(capture, max = 60) {
  const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const fromHtml = (html) => firstLine(String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/gi, ', ') // 표의 첫 줄은 "품목 · 가격"
    .replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
  const title = capture.heading || fromHtml(capture.html) || firstLine(capture.text).replace(/^#+\s*/, '') || '새 메모';
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

// 알림에 보여줄 "어디서" (웹 주소면 사이트 이름, 아니면 창 제목·프로그램)
export function captureWhere(source) {
  if (source.url) {
    try {
      return new URL(source.url).hostname.replace(/^www\./, '');
    } catch {
      // 주소가 이상하면 창 제목으로
    }
  }
  return (source.window || source.process || '').trim();
}

// 메모 끝에 붙이는 출처 한 줄 (마크다운 인용)
export function sourceLine(source) {
  const d = new Date(source.time);
  const pad = (v) => String(v).padStart(2, '0');
  const when = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const esc = (s) => s.replace(/([\\[\]*_`<>])/g, '\\$1');
  const title = (source.window || source.process || '').trim();
  const where = source.url ? `[${esc(title || source.url)}](${source.url})` : esc(title || '클립보드');
  return `> 출처: ${where}, ${when}`;
}
