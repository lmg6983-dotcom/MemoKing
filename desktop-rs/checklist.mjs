// 옮긴 정도 세기: app/preload.cjs 의 채널 · 이벤트를 모두 뽑아, Rust 쪽(app/src)에 있는지 본다 → CHECKLIST.md
//   node desktop-rs/checklist.mjs
//   채널은 ipc.rs 의 match 줄 ("채널" =>), 이벤트는 Rust 어디든 "이벤트" 글자가 있으면 옮긴 것으로 센다.
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const preload = fs.readFileSync(path.join(here, 'app', 'preload.cjs'), 'utf8');
const src = path.join(here, 'app', 'src');
const rust = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.rs')).map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');

const channels = [...new Set([...preload.matchAll(/(?:invoke|send|sendSync)\('([^']+)'/g)].map((m) => m[1]))].sort();
const events = [...preload.match(/const EVENTS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
// Rust 판에 일부러 두지 않는 채널: AI 비서 연결(MCP). AI 는 Google Drive 의 메모 폴더를 직접 읽고 쓴다
const DROPPED = new Set(['mcp:connect', 'mcp:copy', 'mcp:set-write']);
const ported = (ch) => DROPPED.has(ch) || rust.includes(`"${ch}" =>`) || rust.includes(`"${ch}" |`);
const emitted = (ev) => rust.includes(`"${ev}"`);

const row = (name, done) => `| ${DROPPED.has(name) ? '➖' : done ? '✅' : '⬜'} | \`${name}\` |`;
const count = (list, fn) => `${list.filter(fn).length} / ${list.length}`;
const out = `# 데스크탑 Rust 옮기기 체크리스트

\`node desktop-rs/checklist.mjs\` 가 만든다 (손으로 고치지 않음). 100% 가 되면 Electron(\`desktop/\`)을 걷어낸다.

- 채널 (화면 → Rust): **${count(channels, ported)}**
- 이벤트 (Rust → 화면): **${count(events, emitted)}**

➖ 는 Rust 판에 일부러 두지 않은 것 (AI 비서 연결 MCP: AI 는 Google Drive 의 메모 폴더를 직접 읽고 쓴다)

## 채널

| | 이름 |
|---|---|
${channels.map((c) => row(c, ported(c))).join('\n')}

## 이벤트

| | 이름 |
|---|---|
${events.map((e) => row(e, emitted(e))).join('\n')}
`;
fs.writeFileSync(path.join(here, 'CHECKLIST.md'), out);
console.log(`채널 ${count(channels, ported)} · 이벤트 ${count(events, emitted)}`);
