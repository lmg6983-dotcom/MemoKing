// 오류 기록 (PC) — 메인 · 화면(창)에서 난 오류를 이 PC 의 앱 데이터 logs\memoking.log 에만 남긴다 (어디로도 보내지 않음).
//   설정 › 문제 보내기를 누르면 최근 기록을 붙인 새 메일을 사용자의 메일 앱에 띄운다 — 보낼지는 사용자가 정한다.
//   이번처럼 화면 코드가 멈춰도(v0.64 ~ v0.68 목록 창) 사용자가 알려 주기 전에는 몰랐던 것을 기록으로 남기려고.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 512 * 1024; // 넘으면 .1 로 옮기고 새로 (둘까지만)
const MAIL_LINES = 40;
const MAIL_CHARS = 2000; // mailto 주소 길이 — 메일 앱마다 2000자 안팎에서 잘린다 (한글은 한 글자가 9자) · 다 안 들어가면 클립보드로

export function createErrorLog(file, { now = () => new Date() } = {}) {
  function write(text) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${now().toISOString()} ${String(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 1000)}\n`);
    } catch {
      // 기록을 못 남겨도 앱은 그대로
    }
  }
  function tail(n = MAIL_LINES) {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
    } catch {
      return [];
    }
  }
  return { file, write, tail };
}

/** 문제 보내기 메일 (mailto 주소) — 버전 · 운영체제 · 들어가는 만큼의 최근 기록 (긴 것은 오래된 줄부터 뺀다) */
export function problemMail({ to, version, os, lines }) {
  const head = `메모킹 v${version} · ${os}\n\n무슨 일이 있었나요?\n\n\n--- 최근 오류 기록 (전체는 클립보드에 있어요, Ctrl+V) ---\n`;
  const subject = `메모킹 v${version} 문제 알림`;
  const url = (body) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  let picked = lines.slice();
  while (picked.length && url(head + picked.join('\n')).length > MAIL_CHARS) picked = picked.slice(1);
  return url(head + (picked.length ? picked.join('\n') : '(기록된 오류 없음)'));
}
