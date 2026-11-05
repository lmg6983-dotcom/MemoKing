// GitHub Release 본문 (release.yml 이 dist/release-notes.md 로 올린다) — README 이력 표의 한 줄을 읽기 좋게:
//   제목 · 항목 목록(core/release-notes.js 와 같은 나누기) + 받기 표 + 지난 버전과 비교 링크
//   앱의 새 버전 안내(electron-updater releaseNotes)는 이 글이 아니라 이력 표 칸 그대로를 쓴다
import { parseReleaseNotes } from '../app/js/core/release-notes.js';

const REPO = 'https://github.com/lmg6983-dotcom/MemoKing';

/** 이력 표에서 정식 버전(vX.Y.Z) 줄만: [{ version, notes }] (새것부터) */
function rows(readme) {
  const out = [];
  for (const line of String(readme).split('\n')) {
    const m = line.match(/^\| `v(\d+\.\d+\.\d+)` \|/);
    if (m) out.push({ version: m[1], notes: line.split(' | ').slice(3).join(' | ').replace(/\s*\|\s*$/, '').trim() });
  }
  return out;
}

export function releaseBody(readme, version) {
  const all = rows(readme);
  const i = all.findIndex((r) => r.version === version);
  const notes = i === -1 ? '' : all[i].notes;
  const prev = i === -1 ? null : all[i + 1]?.version;

  const lines = ['## ✨ 바뀐 점', ''];
  const blocks = parseReleaseNotes(notes);
  if (!blocks.length) lines.push(`메모킹 v${version}`);
  for (const b of blocks) {
    if (b.type === 'head') lines.push('', `### ${b.text}`, '');
    else lines.push(`- ${b.text}`);
  }
  lines.push(
    '',
    '## 📥 받기',
    '',
    '| | 파일 |',
    '|---|---|',
    `| 🪟 **Windows PC** | [MemoKing-Setup-${version}.exe](${REPO}/releases/download/v${version}/MemoKing-Setup-${version}.exe) |`,
    `| 🤖 **안드로이드** | [MemoKing-android.apk](${REPO}/releases/download/android/MemoKing-android.apk) (늘 최신) |`,
    '',
    '> [!TIP]',
    '> 이미 메모킹을 쓰고 있다면 앱이 새 버전을 알려 줘요. 누르면 바로 업데이트돼요.',
  );
  if (prev) lines.push('', `**전체 변경 내역**: [\`v${prev}...v${version}\`](${REPO}/compare/v${prev}...v${version})`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
