// AI 비서 연결 (MCP 서버) — Claude 데스크톱 같은 AI 비서가 메모킹 메모를 찾고, 읽고, 새로 남기게 한다.
//   AI 비서가 이 파일을 메모킹 실행 파일로 띄운다 (ELECTRON_RUN_AS_NODE=1, 표준 입출력으로 주고받음 — 공식 MCP SDK, MIT).
//   메모 폴더는 메모킹 설정 파일(--settings)에서 매번 읽는다 (설정에서 폴더를 바꿔도 다시 연결할 필요 없게).
//   쓰기(새 메모·덧붙이기)는 설정의 "AI 가 메모를 쓰도록 허용" 이 켜져 있을 때만. 잠근 메모는 내용을 보여 주지 않는다.
//   켜져 있는 메모킹 앱은 폴더를 지켜보다가 바뀐 파일을 바로 다시 읽는다 (다른 기기 동기화와 같은 길).
import fs from 'node:fs';
import { McpServer, StdioServerTransport, z } from './vendor/mcp-sdk.js';
import { Vault } from './vault.js';
import { extractTags } from '../app/js/core/tags.js';
import { isLockedBody } from '../app/js/core/memo-lock.js';
import { describeReminder, nextTime } from '../app/js/core/reminders.js';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const SETTINGS = arg('--settings');
const VERSION = arg('--version') ?? '1';

/** 메모킹 설정 (읽지 못하면 null — 그때는 쓰기를 막는다) */
function settings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return null;
  }
}

let vault = null;
let vaultPath = null;

function closeVault() {
  try {
    vault?.close();
  } catch {
    // 이미 사라진 폴더
  }
  vault = null;
  vaultPath = null;
}

/** 지금 메모 폴더 (설정에서 바뀌었으면 새로 연다) */
function openVault() {
  const s = settings() ?? {};
  const root = arg('--vault') ?? s.vaultPath;
  if (!root || !fs.existsSync(root)) {
    // 폴더를 옮겼거나 외장·네트워크 드라이브가 빠졌다 — 연결은 그대로 두고, 폴더가 돌아오면 다시 연다
    closeVault();
    throw new Error('메모킹 메모 폴더를 찾지 못했어요. 메모 폴더를 옮겼거나 드라이브가 빠졌다면 메모킹에서 폴더를 다시 정해 주세요.');
  }
  if (vault && vaultPath === root) {
    vault.scan({ silent: true });
    return vault;
  }
  closeVault();
  const v = new Vault(root, { device: 'ai' });
  // 이 프로세스는 읽고 쓰기만 — 색인 다시 쓰기·첨부 치우기·폴더 지켜보기는 켜져 있는 메모킹 앱이 맡는다
  // (도구를 부를 때마다 다시 읽으므로 감시·주기 확인이 필요 없고, 폴더가 사라져도 타이머가 서버를 멈추지 않게)
  v.scheduleIndex = () => {};
  v.flushOrphans = () => v.orphans.clear();
  v.watch = () => {};
  v.writeIndex = () => {}; // 색인·안내 파일은 켜져 있는 메모킹 앱이 쓴다 (두 프로세스가 같은 파일을 쓰지 않게)
  v.on('error', (err) => console.error('[memoking-mcp]', err.message));
  v.open();
  vault = v;
  vaultPath = root;
  return vault;
}

// 어떤 예외도 AI 비서와의 연결(표준 입출력)을 끊지 않게 — 다음 도구 호출에서 다시 시도
process.on('uncaughtException', (err) => console.error('[memoking-mcp]', err?.message ?? err));
process.on('unhandledRejection', (err) => console.error('[memoking-mcp]', err?.message ?? err));

// 쓰기는 설정의 "AI 가 메모를 남기도록 허용"(기본 켜짐)을 따른다 — 설정 파일을 읽지 못하면 막는다
const canWrite = () => {
  const s = settings();
  return Boolean(s) && s.mcp?.write !== false;
};

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * id 또는 제목으로 메모 찾기. exact: 고치는 도구(덧붙이기)는 id·제목이 딱 맞을 때만 — 비슷한 말이 든 엉뚱한 메모를 고치지 않게
 */
function findMemo(v, ref, { exact = false } = {}) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  const byId = v.get(key);
  if (byId?.file) return byId;
  const all = v.list();
  let same = all.filter((m) => m.title === key);
  if (!same.length) same = all.filter((m) => m.title.toLowerCase() === key.toLowerCase());
  // 고치는 도구는 제목이 같은 메모가 여럿이면 고르지 않는다 (엉뚱한 쪽에 덧붙이지 않게 — id 로 다시)
  if (exact && same.length > 1) return { ambiguous: same };
  if (same.length) return v.get(same[0].id);
  if (exact) return null;
  const found = v.search(key)[0];
  return found ? v.get(found.id) : null;
}

/** 비슷한 제목 몇 개 (찾지 못했을 때 AI 가 다시 고를 수 있게) */
const closeTitles = (v, ref) => v.search(String(ref ?? '').trim()).slice(0, 5).map((m) => `${m.title} (id: ${m.id})`);

const summaryOf = (m) => {
  const locked = Boolean(m.locked);
  return {
    id: m.id,
    title: m.title,
    tags: locked ? [] : m.tags,
    updated: m.updated,
    pinned: m.pinned || undefined,
    locked: locked || undefined,
    preview: locked ? '(잠긴 메모)' : m.preview,
    tasks: m.tasks?.total ? `${m.tasks.done}/${m.tasks.total} 끝냄` : undefined,
  };
};

const server = new McpServer(
  { name: 'memoking', version: VERSION },
  {
    instructions:
      '메모킹(MemoKing) 사용자의 메모(마크다운)를 찾고 읽고 남기는 도구입니다. 먼저 search_memos 로 찾고 read_memo 로 읽으세요. '
      + '새로 남길 때는 첫 줄을 "# 제목" 으로 쓰면 그 제목이 파일 이름이 됩니다. #태그 는 본문 어디에나 쓸 수 있습니다. '
      + '잠긴 메모(locked)는 내용을 볼 수 없습니다.',
  },
);

server.registerTool('search_memos', {
  title: '메모 찾기',
  description: '메모킹 메모를 찾습니다. query 를 비우면 최근에 고친 메모부터. 제목·본문·#태그·초성(ㅈㅂㄱ)으로 찾을 수 있습니다.',
  inputSchema: { query: z.string().optional().describe('찾을 말 (비우면 최근 메모)'), tag: z.string().optional().describe('이 태그가 있는 메모만 (# 없이)'), limit: z.number().int().min(1).max(50).optional() },
  annotations: { readOnlyHint: true },
}, async ({ query = '', tag, limit = 10 }) => {
  try {
    const v = openVault();
    let list = query.trim() ? v.search(query.trim()) : v.list();
    if (tag) {
      const want = tag.replace(/^#/, '').toLowerCase();
      list = list.filter((m) => m.tags.some((t) => t.toLowerCase() === want));
    }
    const shown = list.slice(0, limit).map(summaryOf);
    return text({ total: list.length, memos: shown });
  } catch (err) {
    return fail(err.message);
  }
});

server.registerTool('read_memo', {
  title: '메모 읽기',
  description: '메모 한 개의 전체 내용(마크다운)을 읽습니다. memo 에는 id 또는 제목을 넣으세요.',
  inputSchema: { memo: z.string().describe('메모 id 또는 제목') },
  annotations: { readOnlyHint: true },
}, async ({ memo }) => {
  try {
    const v = openVault();
    const m = findMemo(v, memo);
    if (!m) return fail(`"${memo}" 메모를 찾지 못했어요. search_memos 로 먼저 찾아 주세요.`);
    // 제목·id 가 딱 맞지 않아 찾기로 고른 메모면 그렇다고 알린다 (다른 메모를 그 메모로 오해하지 않게)
    const exactHit = m.id === String(memo).trim() || m.title.toLowerCase() === String(memo).trim().toLowerCase();
    if (isLockedBody(m.body)) return fail(`"${m.title}" 은(는) 잠긴 메모라 내용을 볼 수 없어요.`);
    const reminders = (m.reminders ?? []).filter((r) => r.enabled).map((r) => {
      const next = nextTime(r);
      return { when: describeReminder(r), next: Number.isFinite(next) ? new Date(next).toISOString() : null };
    });
    return text({
      ...(exactHit ? {} : { note: `"${memo}" 와(과) 제목이 같은 메모가 없어 가장 비슷한 메모를 읽었어요: "${m.title}"` }),
      id: m.id, title: m.title, file: m.file, updated: m.updated, tags: extractTags(m.body), reminders, content: m.body,
    });
  } catch (err) {
    return fail(err.message);
  }
});

server.registerTool('list_tags', {
  title: '태그 목록',
  description: '메모에 쓰인 #태그 와 메모 수 (많이 쓴 순).',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  try {
    const v = openVault();
    const counts = new Map();
    for (const m of v.list()) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return text([...counts].sort((a, b) => b[1] - a[1]).map(([tag, memos]) => ({ tag, memos })));
  } catch (err) {
    return fail(err.message);
  }
});

server.registerTool('create_memo', {
  title: '새 메모 남기기',
  description: '새 메모를 만듭니다. content 는 마크다운 — 첫 줄을 "# 제목" 으로 쓰세요. 체크리스트는 "- [ ] 할 일".',
  inputSchema: {
    content: z.string().min(1).describe('메모 내용 (마크다운)'),
    color: z.enum(['yellow', 'green', 'pink', 'purple', 'blue', 'gray', 'charcoal']).optional().describe('메모 색 (기본 노랑)'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ content, color }) => {
  if (!canWrite()) return fail('메모킹 설정에서 "AI가 메모를 남기도록 허용" 이 꺼져 있어요.');
  if (!content.trim()) return fail('메모 내용이 비어 있어요. content 에 남길 글을 넣어 주세요.');
  if (isLockedBody(content)) return fail('잠금 메모 형식의 글은 남길 수 없어요 (아무도 열 수 없는 메모가 돼요).');
  try {
    const v = openVault();
    const id = v.create({ color });
    v.save(id, `${content.trim()}\n`);
    v.finalize(id);
    const m = v.get(id);
    if (!m) return fail('메모를 남기지 못했어요.');
    return text({ ok: true, id, title: m.title, file: m.file });
  } catch (err) {
    return fail(err.message);
  }
});

server.registerTool('append_to_memo', {
  title: '메모에 덧붙이기',
  description: '이미 있는 메모의 끝에 내용을 덧붙입니다 (지우거나 고치지 않음). memo 에는 id 또는 정확한 제목 (모르면 search_memos 로 먼저 찾기).',
  inputSchema: { memo: z.string().describe('메모 id 또는 제목'), content: z.string().min(1).describe('덧붙일 마크다운') },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ memo, content }) => {
  if (!canWrite()) return fail('메모킹 설정에서 "AI가 메모를 남기도록 허용" 이 꺼져 있어요.');
  try {
    const v = openVault();
    const m = findMemo(v, memo, { exact: true });
    if (m?.ambiguous) return fail(`제목이 "${memo}" 인 메모가 ${m.ambiguous.length}개예요: ${m.ambiguous.map((x) => `${x.title} (id: ${x.id}, ${x.updated ?? ''})`).join(', ')} — 덧붙일 메모의 id 로 다시 불러 주세요.`);
    if (!m) {
      const near = closeTitles(v, memo);
      return fail(`"${memo}" 와(과) 제목이 같은 메모가 없어요.${near.length ? ` 비슷한 메모: ${near.join(', ')} — 맞는 것의 id 로 다시 불러 주세요.` : ' search_memos 로 먼저 찾아 주세요.'}`);
    }
    if (isLockedBody(m.body)) return fail(`"${m.title}" 은(는) 잠긴 메모라 덧붙일 수 없어요.`);
    if (!content.trim()) return fail('덧붙일 내용이 비어 있어요.');
    if (/<!--\s*memoking-lock/.test(content)) return fail('잠금 정보가 든 글은 덧붙일 수 없어요.');
    // 목록 끝에 목록을 덧붙이면 한 목록으로 이어지게 (빈 줄 없이)
    const before = m.body.replace(/\s+$/, '');
    const add = content.trim();
    const isItem = (line) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line ?? '');
    const gap = isItem(before.split('\n').at(-1)) && isItem(add.split('\n')[0]) ? '\n' : '\n\n';
    const body = `${before}${gap}${add}\n`;
    const saved = v.save(m.id, body);
    if (saved?.refused) return fail(`"${m.title}" 은(는) 방금 다른 기기에서 잠겨 덧붙이지 못했어요.`);
    return text({ ok: true, id: m.id, title: m.title });
  } catch (err) {
    return fail(err.message);
  }
});

await server.connect(new StdioServerTransport());
