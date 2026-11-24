// 받은 메모 빈 칸 (_memoking/받은 메모/빈 메모 001~100.md) — 순수 함수 (Rust: core/src/inbox.rs)
//   메모킹은 Google Drive 에서 메모킹이 만든 파일만 본다(drive.file): Gemini 같은 AI 가 새로 만든 파일은 보이지 않는다.
//   그래서 메모킹이 빈 칸 파일을 미리 만들어 두고, AI 는 새 메모를 쓸 때 빈 칸 하나를 그 자리에서 덮어쓴다 (메모킹이 만든 파일이라 모든 기기가 본다).
//   켜져 있는 메모킹(PC · 휴대폰)이 채워진 칸을 보통 메모로 옮기고 다시 비운다
import { parseMemoFile } from './memo-file.js';

export const INBOX_DIR = '_memoking/받은 메모';
export const INBOX_SLOTS = 100;
export const SLOT_TEXT = '<!-- 메모킹 빈 칸: AI 비서(Gemini 등)는 새 메모를 쓸 때 이 파일 전체를 새 메모 글로 덮어쓰세요. 메모킹이 메모로 옮기고 다시 비워요 -->\n';

/** n 번째 칸의 파일 이름 (1 부터): "빈 메모 001.md" */
export const slotName = (n) => `빈 메모 ${String(n).padStart(3, '0')}.md`;

const COMMENT = SLOT_TEXT.trim();

/**
 * 칸의 글 → 옮길 메모 { body, color } (비었으면 null)
 *   AI 가 안내 주석을 남긴 채 아래에 썼어도 그 줄은 뺀다. 머리말(색)을 붙여 썼으면 색만 쓴다 (id 등은 새로)
 */
export function slotMemo(text) {
  const raw = String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const cleaned = raw.split('\n').filter((l) => l.trim() !== COMMENT).join('\n');
  if (!cleaned.trim()) return null;
  const { meta, body } = parseMemoFile(cleaned);
  const b = body.trim();
  return b ? { body: `${b}\n`, color: meta.color } : null;
}
