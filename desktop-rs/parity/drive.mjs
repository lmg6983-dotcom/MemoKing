// Google Drive 동기화 장면들 (gen.mjs → fixtures/drive_sync.json): 이 PC 폴더 · 가짜 Drive · 기준 기록 → 한 번 맞춘 뒤의 양쪽 · 기준 · 결과.
//   가짜 Drive 의 id 는 경로로 정한다 (x:파일 · d:폴더) — Rust 가 여러 줄로 한꺼번에 올려도 같은 id 가 되게. 같은 가짜를 core/tests/parity.rs 에도 둔다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SyncEngine } from '../../desktop/drive/sync-engine.js';
import { pickChanges } from '../../desktop/drive/drive-api.js';

const T0 = 1_790_000_000_000;
const NOW = 1_795_000_000_000;
const md5 = (t) => createHash('md5').update(t).digest('hex');
const base = (rel, text, mtime = T0) => [rel, { id: `x:${rel}`, md5: md5(text), lmtime: mtime, lsize: Buffer.byteLength(text) }];
const files = (...b) => Object.fromEntries(b);
const recent = { pageToken: 't0', lastFullScan: NOW - 60_000, folders: { '': 'root0' }, dirs: [] };
const names = (n) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, '0')}.md`);
const md = (name, text, parents, extra = {}) => ({ name, mimeType: 'text/markdown', md5Checksum: md5(text), parents, ...extra });
const dir = (name, parents) => ({ name, mimeType: 'application/vnd.google-apps.folder', parents });

// local: { 경로: 글 | [글, 고친 시각] , '폴더/': '' } · remote: { 경로: 글 | { text, id, name, modified, gdoc }, '폴더/': '' } · raw: Drive changes (없으면 처음처럼)
const scenes = [
  { name: 'first', local: { 'a.md': 'A', 'Work/b.md': 'B', '.x.tmp': 't', '_memoking/index.json': '{}', 'desktop.ini': 'x', 'Empty/': '' },
    remote: { 'c.md': 'C', 'Life/d.md': 'D', 'Remote Empty/': '', 'g.gdoc': { gdoc: true } }, state: {} },
  { name: 'local-edit', local: { 'a.md': ['A2', T0 + 1000] }, remote: { 'a.md': 'A' }, state: { ...recent, files: files(base('a.md', 'A')) }, raw: [] },
  { name: 'remote-edit', local: { 'a.md': 'A' }, remote: { 'a.md': 'A3' }, state: { ...recent, files: files(base('a.md', 'A')) },
    raw: [{ fileId: 'x:a.md', file: md('a.md', 'A3', ['root0'], { modifiedTime: '2026-11-17T00:00:00Z', size: '2' }) }] },
  { name: 'both-edit', local: { 'Work/a.md': ['mine', T0 + 1000] }, remote: { 'Work/a.md': 'theirs' }, state: { files: files(base('Work/a.md', 'A')), pageToken: 't0' }, raw: [] },
  { name: 'both-same', local: { 'a.md': ['same', T0 + 1000] }, remote: { 'a.md': 'same' }, state: { files: files(base('a.md', 'A')), pageToken: 't0' }, raw: [] },
  { name: 'deletes', local: { 'keep.md': 'K', 'gone-remote.md': 'R', 'revive-local.md': ['L2', T0 + 1000] }, remote: { 'keep.md': 'K', 'gone-local.md': 'G', 'revive-remote.md': 'V2' },
    state: { files: files(base('keep.md', 'K'), base('gone-remote.md', 'R'), base('gone-local.md', 'G'), base('revive-local.md', 'L'), base('revive-remote.md', 'V'), base('both.md', 'B')), pageToken: 't0' }, raw: [] },
  { name: 'mass-remote-gone', local: Object.fromEntries(names(25).map((n) => [n, n])), remote: {}, state: { files: files(...names(25).map((n) => base(n, n))), pageToken: 't0' }, raw: [] },
  { name: 'local-empty', local: {}, remote: { 'a.md': 'A', 'b.md': 'B' }, state: { files: files(base('a.md', 'A'), base('b.md', 'B')), pageToken: 't0' }, raw: [] },
  { name: 'mass-conflict', local: Object.fromEntries(names(21).map((n) => [n, [`mine ${n}`, T0 + 1000]])), remote: Object.fromEntries(names(21).map((n) => [n, `theirs ${n}`])),
    state: { files: files(...names(21).map((n) => base(n, n))), pageToken: 't0' }, raw: [] },
  { name: 'link-previews', local: { '_memoking/link-previews.json': ['{"a":1,"b":2}', T0 + 1000] }, remote: { '_memoking/link-previews.json': '{"b":3,"c":"씨"}' },
    state: { files: files(base('_memoking/link-previews.json', '{}')), pageToken: 't0' }, raw: [] },
  { name: 'dirs', local: { 'Gone/desktop.ini': 'x', 'New/': '', 'Kept/': '', 'a.md': 'A' }, remote: { 'Kept/': '', 'RemoteNew/': '', 'Old/': '', 'a.md': 'A' },
    state: { files: files(base('a.md', 'A')), pageToken: 't0', dirs: ['Gone', 'Kept', 'Old'] }, raw: [] },
  { name: 'peek-skip', opts: { localClean: true }, local: { 'a.md': 'A' }, remote: { 'a.md': 'A' }, state: { ...recent, files: files(base('a.md', 'A')) }, raw: [] },
  { name: 'nothing-changed', local: { 'a.md': 'A' }, remote: { 'a.md': 'A' }, state: { ...recent, files: files(base('a.md', 'A')) }, raw: [] },
  // 새 폴더가 그 안의 파일보다 뒤에 온다 (Drive 가 그렇게 준다) · 이 메모 폴더 밖의 것은 빠진다
  { name: 'new-folder-in-changes', local: { 'a.md': 'A' }, remote: { 'a.md': 'A', 'New/Deep/n.md': 'N' }, state: { ...recent, files: files(base('a.md', 'A')) },
    raw: [
      { fileId: 'x:New/Deep/n.md', file: md('n.md', 'N', ['d:New/Deep']) },
      { fileId: 'd:New/Deep', file: dir('Deep', ['d:New']) },
      { fileId: 'd:New', file: dir('New', ['root0']) },
      { fileId: 'x:elsewhere', file: md('z.md', 'Z', ['other']) },
    ] },
  { name: 'rename-full-walk', local: { 'a.md': 'A' }, remote: { 'b.md': { text: 'A', id: 'x:a.md' } }, state: { ...recent, files: files(base('a.md', 'A')) },
    raw: [{ fileId: 'x:a.md', file: md('b.md', 'A', ['root0']) }] },
  { name: 'removed-in-changes', local: { 'a.md': 'A', 'b.md': 'B' }, remote: { 'b.md': 'B' }, state: { ...recent, files: files(base('a.md', 'A'), base('b.md', 'B')) },
    raw: [{ fileId: 'x:a.md', removed: true }] },
  { name: 'trashed-folder-in-changes', local: { 'W/a.md': 'A' }, remote: {}, state: { ...recent, folders: { '': 'root0', W: 'd:W' }, files: files(base('W/a.md', 'A')) },
    raw: [{ fileId: 'd:W', file: { ...dir('W', ['root0']), trashed: true } }] },
  { name: 'keep-missing', local: { 'a.md': 'A' }, remote: {}, state: { files: files(base('a.md', 'A')), pageToken: 't0', keepMissing: true }, raw: [] },
  { name: 'duplicate-names', local: {}, remote: { 'a.md': { text: 'old', id: 'x:a1', modified: 1 }, 'a2': { text: 'new', id: 'x:a2', modified: 2, name: 'a.md' } }, state: {} },
  { name: 'full-button', opts: { full: true }, local: { 'a.md': 'A' }, remote: { 'a.md': 'A', 'b.md': 'B' }, state: { ...recent, files: files(base('a.md', 'A')) }, raw: [] },
];

class FakeDrive {
  constructor(remote, raw) {
    this.items = new Map([['root0', { id: 'root0', folder: true, parent: null, name: '' }]]);
    this.raw = raw;
    for (const [p, v] of Object.entries(remote)) {
      const o = typeof v === 'string' ? { text: v } : v;
      const parts = p.replace(/\/$/, '').split('/');
      let parent = 'root0';
      for (let i = 0; i < parts.length - (p.endsWith('/') ? 0 : 1); i++) parent = this.folder(parent, parts.slice(0, i + 1).join('/'), parts[i]);
      if (p.endsWith('/')) continue;
      const id = o.id ?? `x:${p}`;
      this.items.set(id, { id, name: o.name ?? parts.at(-1), parent, folder: false, data: Buffer.from(o.text ?? ''), gdoc: o.gdoc, modified: o.modified ?? 0 });
    }
  }

  folder(parent, rel, name) {
    const id = `d:${rel}`;
    if (!this.items.has(id)) this.items.set(id, { id, name, parent, folder: true, modified: 0 });
    return id;
  }

  pathOf(id) {
    const it = this.items.get(id);
    return it.parent ? [this.pathOf(it.parent), it.name].filter(Boolean).join('/') : '';
  }

  out(it) {
    return { id: it.id, name: it.name, folder: it.folder, md5: it.folder || it.gdoc ? null : md5(it.data), modified: it.modified, created: 0, size: it.data?.length ?? 0 };
  }

  async listChildren(id) {
    return [...this.items.values()].filter((it) => it.parent === id && !it.trashed).map((it) => this.out(it));
  }

  async download(id, file) {
    fs.writeFileSync(file, this.items.get(id).data);
  }

  async upload(parent, name, existing, file) {
    const data = fs.readFileSync(file);
    let id = existing;
    if (id) Object.assign(this.items.get(id), { data, modified: NOW });
    else {
      id = `x:${[this.pathOf(parent), name].filter(Boolean).join('/')}`;
      while (this.items.has(id)) id += '+';
      this.items.set(id, { id, name, parent, folder: false, data, modified: NOW });
    }
    return this.out(this.items.get(id));
  }

  async createFolder(parent, name) {
    return this.out(this.items.get(this.folder(parent, [this.pathOf(parent), name].filter(Boolean).join('/'), name)));
  }

  async trash(id) {
    this.items.get(id).trashed = true;
  }

  async changesSince(token, known) {
    if (!token || !this.raw) return { changed: true, token: 't1', items: null };
    const items = pickChanges(this.raw, known);
    return { changed: items.length > 0, token: 't2', items };
  }

  tree() {
    const live = {};
    const trashed = [];
    for (const it of this.items.values()) {
      if (it.id === 'root0') continue;
      if (it.trashed) trashed.push(this.pathOf(it.id));
      else live[this.pathOf(it.id) + (it.folder ? '/' : '')] = it.folder ? '' : it.data.toString();
    }
    return { live, trashed: trashed.sort() };
  }
}

function localTree(root) {
  const out = {};
  for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const rel = path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    out[rel + (e.isDirectory() ? '/' : '')] = e.isDirectory() ? '' : fs.readFileSync(path.join(root, rel), 'utf8');
  }
  return out;
}

export async function driveCases() {
  const cases = [];
  for (const s of scenes) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-drive-'));
    for (const [rel, v] of Object.entries(s.local)) {
      const file = path.join(root, rel);
      if (rel.endsWith('/')) {
        fs.mkdirSync(file, { recursive: true });
        continue;
      }
      const [text, mtime] = Array.isArray(v) ? v : [v, T0];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      fs.utimesSync(file, mtime / 1000, mtime / 1000);
    }
    const remote = new FakeDrive(s.remote, s.raw ?? null);
    const state = structuredClone(s.state);
    let result;
    try {
      const r = await new SyncEngine({ root, remote, rootId: 'root0', state, now: () => NOW, concurrency: 1 }).run(s.opts ?? {});
      result = { skipped: r.skipped, uploaded: r.uploaded, downloaded: r.downloaded, deletedLocal: r.deletedLocal, deletedRemote: r.deletedRemote, conflicts: [...r.conflicts].sort(), localChanged: r.localChanged };
    } catch (err) {
      result = { error: err.message };
    }
    // 내려받은 파일의 고친 시각은 돌릴 때마다 달라 기준에서 뺀다
    const base2 = Object.fromEntries(Object.entries(state.files ?? {}).map(([rel, b]) => [rel, { id: b.id, md5: b.md5, lsize: b.lsize }]));
    cases.push({
      ...s, now: NOW, mtime: T0, raw: s.raw ?? null, opts: s.opts ?? {},
      out: {
        result, local: localTree(root), remote: remote.tree(),
        state: { pageToken: state.pageToken ?? null, files: base2, folders: state.folders ?? null, dirs: state.dirs ?? null, lastFullScan: state.lastFullScan ?? null, keepMissing: state.keepMissing ?? null },
      },
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
  return cases;
}
