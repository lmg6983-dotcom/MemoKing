// AI 요청 메모 (_memoking/AI 요청.md) — Gemini 같은 AI 비서가 메모를 고치는 길 (순수 함수, Rust: core/src/ai_requests.rs)
//   AI 의 Drive 도구는 파일을 통째로 다시 쓰기만 한다: 큰 메모를 다시 쓰면 잘리거나 바뀐다.
//   메모킹은 Drive 에서 메모킹이 만든 파일만 본다(drive.file): AI 가 새로 만든 파일은 보이지 않는다.
//   그래서 메모킹이 만들어 둔 이 작은 파일 하나에 AI 가 요청(json)을 적고, 메모킹이 메모를 고친 뒤 결과를 적고 비운다.
//   같은 요청을 PC 와 휴대폰이 함께 반영해도 괜찮게: 할 일이 이미 되어 있으면 '이미 됨' 으로 넘어간다
import { extractTags, isValidTag, TAG_CHAR } from './tags.js';
import { appendTags } from './tag-suggest.js';
import { extractTitle } from './memo-file.js';
import { isLockedBody } from './memo-lock.js';
import { cleanFolderName, folderOf } from './folders.js';

export const REQUESTS_FILE = '_memoking/AI 요청.md';
export const MAX_OPS = 50;
export const DOS = ['tag', 'color', 'move', 'replace', 'append', 'merge', 'trash', 'create'];
const COLORS = ['yellow', 'green', 'pink', 'purple', 'blue', 'gray', 'charcoal'];

const GUIDE = `# 메모킹 AI 요청

AI 비서(Gemini 등)는 메모를 직접 다시 쓰지 말고 이 파일만 고쳐 주세요. 아래 json 칸에 요청을 넣고 이 파일 전체를 다시 저장하면, 메모킹(PC · 휴대폰)이 메모를 고치고 이 파일에 결과를 적은 뒤 칸을 비워요.
메모 주소(memo)는 메모의 id 또는 메모 폴더 기준 파일 경로("업무/회의.md")예요. 자세한 방법은 _memoking/README.md 에 있어요.

\`\`\`json
[]
\`\`\`
`;

const FENCE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/;

/** 요청 메모 → { ops: [...], error } — 요청이 없으면 ops 가 비어 있다 */
export function parseRequests(text) {
  const m = String(text ?? '').match(FENCE);
  if (!m || !m[1].trim()) return { ops: [], error: '' };
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    return { ops: [], error: `요청(json)을 읽지 못했어요: ${err.message}` };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.ops) ? data.ops : null;
  if (!list) return { ops: [], error: '요청은 [ ... ] 목록이어야 해요' };
  return { ops: list.slice(0, MAX_OPS).map(normalizeOp), error: list.length > MAX_OPS ? `한 번에 ${MAX_OPS}개까지만 했어요` : '' };
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const names = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((n) => str(n).trim().replace(/^#/, '')).filter(Boolean);

/** 요청 하나를 정리 — 모르는 요청은 { do, error } */
export function normalizeOp(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const what = str(o.do ?? o.op).trim().toLowerCase();
  const memo = str(o.memo ?? o.id ?? o.file).trim();
  switch (what) {
    case 'tag': {
      const add = names(o.add);
      const remove = names(o.remove);
      const bad = [...add, ...remove].find((n) => !isValidTag(n));
      if (bad) return { do: what, memo, error: `#${bad} 는 태그로 쓸 수 없어요` };
      return add.length || remove.length ? { do: what, memo, add, remove } : { do: what, memo, error: '더하거나 뺄 태그가 없어요' };
    }
    case 'color': {
      const color = str(o.color).trim().toLowerCase();
      return COLORS.includes(color) ? { do: what, memo, color } : { do: what, memo, error: `색은 ${COLORS.join(' · ')} 가운데 하나예요` };
    }
    case 'move':
      return { do: what, memo, folder: str(o.folder ?? o.to).trim().replace(/^\/+|\/+$/g, '') };
    case 'replace': {
      const find = str(o.find).replace(/\r\n/g, '\n');
      return find ? { do: what, memo, find, with: str(o.with ?? o.replace).replace(/\r\n/g, '\n') } : { do: what, memo, error: '바꿀 글(find)이 없어요' };
    }
    case 'append': {
      const text = str(o.text).replace(/\r\n/g, '\n').trim();
      return text ? { do: what, memo, text } : { do: what, memo, error: '덧붙일 글(text)이 없어요' };
    }
    case 'merge': {
      const into = str(o.into ?? o.memo).trim();
      const from = (Array.isArray(o.from) ? o.from : [o.from]).map((x) => str(x).trim()).filter((x) => x && x !== into);
      return into && from.length ? { do: what, memo: into, from } : { do: what, memo: into, error: '합칠 메모(into · from)가 없어요' };
    }
    case 'trash':
      return { do: what, memo };
    case 'create': {
      const text = str(o.text ?? o.body).replace(/\r\n/g, '\n').trim();
      const color = str(o.color).trim().toLowerCase();
      return text
        ? { do: what, memo: '', text, folder: str(o.folder).trim().replace(/^\/+|\/+$/g, ''), color: COLORS.includes(color) ? color : '' }
        : { do: what, memo: '', error: '새 메모의 글(text)이 없어요' };
    }
    default:
      return { do: what, memo, error: `모르는 요청이에요 (${what || '빈 do'}) — ${DOS.join(' · ')}` };
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tagKey = (n) => n.toLocaleLowerCase('ko');

// 본문에서 #태그 를 뺀다 (코드 칸 밖, 뒤 띄어쓰기 하나와 함께). put 이 있으면 뺀 자리 하나에 넣는다
//   — 태그만 있는 줄(#ETRI #공유)이 있으면 그 줄, 없으면 처음 나온 자리
const TAG_ONLY = /^(\s*#[^\s#]+)+\s*$/u;
function dropTags(body, drop, put) {
  const res = drop.map((name) => new RegExp(`(^|[\\s(\\[{,;:!?'"“‘>*_~])#${escapeRe(name)}(?!${TAG_CHAR})([ \\t]?)`, 'giu'));
  const lines = body.split('\n');
  let fence = false;
  const code = lines.map((line) => {
    const edge = /^\s*(```|~~~)/.test(line);
    if (edge) fence = !fence;
    return edge || fence || /^( {4}|\t)/.test(line);
  });
  const has = (i) => !code[i] && res.some((re) => (re.lastIndex = 0, re.test(lines[i])));
  const hits = lines.map((_, i) => i).filter(has);
  const target = put ? (hits.find((i) => TAG_ONLY.test(lines[i])) ?? hits[0]) : -1;
  const out = [];
  lines.forEach((line, i) => {
    if (!hits.includes(i)) return out.push(line);
    let placed = i !== target;
    let next = line;
    for (const re of res) {
      next = next.replace(re, (_, pre, gap) => {
        if (placed) return pre;
        placed = true;
        return `${pre}${put}${gap}`;
      });
    }
    if (next.trim()) out.push(next.trimEnd()); // 태그만 있던 줄이 비면 줄째로 뺀다
  });
  return { body: out.join('\n'), placed: target >= 0 };
}

/**
 * 본문만 고치는 요청 (tag · replace · append) → { body, status: 'ok' | 'same' | 'fail', note }
 *   same: 이미 되어 있다 (다른 기기가 먼저 반영했거나 같은 요청을 또 보냈다)
 */
export function editBody(body, op) {
  const text = str(body).replace(/\r\n/g, '\n');
  if (op.do === 'tag') {
    const have = new Set(extractTags(text).map(tagKey));
    const remove = op.remove.filter((n) => have.has(tagKey(n)));
    const add = op.add.filter((n, i, all) => !have.has(tagKey(n)) && all.findIndex((x) => tagKey(x) === tagKey(n)) === i);
    if (!remove.length && !add.length) return { body: text, status: 'same', note: '이미 그 태그예요' };
    let next = text;
    let placed = false;
    if (remove.length) ({ body: next, placed } = dropTags(text, remove, add.map((n) => `#${n}`).join(' ')));
    if (add.length && !placed) next = appendTags(next, add);
    const note = [add.length && `${add.map((n) => `#${n}`).join(' ')} 더함`, remove.length && `${remove.map((n) => `#${n}`).join(' ')} 뺌`].filter(Boolean).join(', ');
    return { body: tidyEnd(next), status: 'ok', note };
  }
  if (op.do === 'replace') {
    const count = text.split(op.find).length - 1;
    if (count === 1) return { body: text.replace(op.find, () => op.with), status: 'ok', note: '글을 바꿈' };
    if (!count && op.with && text.includes(op.with)) return { body: text, status: 'same', note: '이미 바뀌어 있어요' };
    return { body: text, status: 'fail', note: count ? `바꿀 글이 ${count}곳에 있어요 — 한 곳만 있게 더 길게 적어 주세요` : '바꿀 글을 찾지 못했어요' };
  }
  if (op.do === 'append') {
    if (text.includes(op.text)) return { body: text, status: 'same', note: '이미 들어 있어요' };
    return { body: `${text.replace(/\s+$/, '')}\n\n${op.text}\n`, status: 'ok', note: '끝에 덧붙임' };
  }
  return { body: text, status: 'fail', note: '본문 요청이 아니에요' };
}

const tidyEnd = (s) => `${s.replace(/\s+$/, '')}\n`;

/** 합치기: 받는 메모 끝에 다른 메모 글을 잇는다 — 이미 들어 있는 글은 다시 넣지 않는다 */
export function mergeBodies(into, froms) {
  let text = str(into).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  let added = 0;
  for (const b of froms) {
    const part = str(b).replace(/\r\n/g, '\n').trim();
    if (!part || text.includes(part)) continue;
    text = `${text}\n\n---\n\n${part}`;
    added++;
  }
  return { body: `${text}\n`, added };
}

const ICON = { ok: '✅', same: '➖', fail: '⚠️' };
const LABEL = { tag: '태그', color: '색', move: '옮기기', replace: '글 바꾸기', append: '덧붙이기', merge: '합치기', trash: '지우기', create: '새 메모' };

/** 결과 한 줄: "- ✅ 태그 · OA 프롬프트 — #프롬프트 더함" */
export function resultLine({ op, title = '', status, note = '' }) {
  const what = LABEL[op?.do] ?? (op?.do || '요청');
  const who = title || op?.memo || '';
  return `- ${ICON[status] ?? ICON.fail} ${what}${who ? ` · ${who}` : ''}${note ? ` — ${note}` : ''}`;
}

/** 요청을 반영한 뒤 쓸 글 — 칸은 비우고 결과를 아래에 (lines 가 없으면 안내만) */
export function requestsText(lines = [], stamp = '') {
  if (!lines.length) return GUIDE;
  return `${GUIDE}\n## 지난 결과${stamp ? ` (${stamp})` : ''}\n\n${lines.join('\n')}\n`;
}

// ---------- 메모 폴더에 반영 (휴대폰 vault.js — PC 는 core/src/vault.rs apply_ai_ops) ----------

/** 메모 주소(id 또는 "업무/회의.md") → 메모 */
export function findMemo(entries, ref) {
  const r = str(ref).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r) return null;
  const list = [...entries];
  const same = (f, want) => f === want || f === `${want}.md`;
  const hit = list.find((e) => e.id === r) ?? list.find((e) => e.file && same(e.file, r));
  if (hit) return hit;
  // 다른 기기가 먼저 다른 폴더로 옮겼다: 파일 이름이 하나뿐이면 그것
  const base = r.slice(r.lastIndexOf('/') + 1);
  const named = list.filter((e) => e.file && same(e.file.slice(e.file.lastIndexOf('/') + 1), base));
  return named.length === 1 ? named[0] : null;
}

const editable = (e) => (!e ? '메모를 찾지 못했어요' : e.secret || !e.file || isLockedBody(e.body) ? '잠긴 메모는 고치지 않아요' : '');

/**
 * 요청들을 메모 폴더에 반영 → 결과 줄들. 본문을 고치기 전 글은 지난 버전으로 남긴다 (되돌릴 수 있게)
 * @param {object} vault entries(Map) · save · setMeta · moveToFolder · trash · create · keepVersion
 */
export function applyOps(vault, ops) {
  const entries = () => vault.entries.values();
  const titleOf = (e) => (e ? extractTitle(e.body) || e.file || e.id : '');
  const keep = (e) => vault.keepVersion(e.id, e.body, { force: true });
  // 저장이 거절되면(다른 기기가 막 옮기거나 지운 메모 등) 멈춘다 — 합치기가 받는 메모에 글을 못 넣고 보낸 메모만 지우지 않게
  const save = (id, body) => {
    if (vault.save(id, body)?.refused) throw new Error('지금은 저장하지 못했어요 (다른 기기에서 막 바뀐 메모) — 다시 요청해 주세요');
  };
  return ops.map((op) => {
    const e = op.memo ? findMemo(entries(), op.memo) : null;
    const title = titleOf(e); // 고치기 전 제목 (PC 와 같은 결과 글 — 두 기기가 다른 글을 써 Drive 충돌 사본이 생기지 않게)
    const done = (status, note, memo = null) => resultLine({ op, title: memo ? titleOf(memo) : title, status, note });
    if (op.error) return done('fail', op.error);
    try {
      if (op.do === 'create') {
        if ([...entries()].some((x) => x.body.trim() === op.text)) return done('same', '같은 메모가 이미 있어요');
        const id = vault.create({ color: op.color || undefined, folder: op.folder });
        save(id, `${op.text}\n`);
        return done('ok', op.folder ? `${op.folder} 폴더에 만듦` : '만듦', vault.entries.get(id));
      }
      const why = editable(e);
      if (why) return done('fail', why);
      if (op.do === 'tag' || op.do === 'replace' || op.do === 'append') {
        const r = editBody(e.body, op);
        if (r.status === 'ok') {
          keep(e);
          save(e.id, r.body);
        }
        return done(r.status, r.note);
      }
      if (op.do === 'color') {
        if (e.meta.color === op.color) return done('same', '이미 그 색이에요');
        vault.setMeta(e.id, { color: op.color });
        return done('ok', `${op.color} 로 바꿈`);
      }
      if (op.do === 'move') {
        const dir = op.folder ? cleanFolderName(op.folder) : '';
        if (op.folder && !dir) return done('fail', '폴더 이름으로 쓸 수 없어요');
        if (folderOf(e.file) === dir) return done('same', '이미 그 폴더예요');
        vault.moveToFolder(e.id, dir);
        return done('ok', dir ? `${dir} 폴더로` : '맨 위로');
      }
      if (op.do === 'trash') {
        vault.trash(e.id);
        return done('ok', '휴지통으로');
      }
      if (op.do === 'merge') {
        const froms = op.from.map((ref) => findMemo(entries(), ref)).filter((x, i, all) => x && x !== e && !editable(x) && all.indexOf(x) === i);
        if (!froms.length) return done('same', '합칠 메모가 없어요 (이미 합쳤거나 없는 메모)');
        const { body, added } = mergeBodies(e.body, froms.map((x) => x.body));
        if (added) {
          keep(e);
          save(e.id, body);
        }
        for (const x of froms) vault.trash(x.id);
        return done('ok', `${froms.length}개를 합치고 휴지통으로`);
      }
      return done('fail', '모르는 요청이에요');
    } catch (err) {
      return done('fail', err?.message || '하지 못했어요');
    }
  });
}
