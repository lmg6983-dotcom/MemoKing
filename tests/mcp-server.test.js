import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SERVER = path.join(import.meta.dirname, '..', 'desktop', 'mcp-server.js');

/** 표준 입출력으로 MCP 서버와 주고받기 */
function connect(vaultDir, { settingsFile = path.join(vaultDir, '..', 'settings.json') } = {}) {
  if (!fs.existsSync(settingsFile) && !settingsFile.endsWith('none.json')) fs.writeFileSync(settingsFile, '{}'); // 기본 설정 (쓰기 허용)
  const proc = spawn(process.execPath, [SERVER, '--vault', vaultDir, '--settings', settingsFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buf = '';
  let exited = null;
  proc.on('exit', (code) => (exited = code ?? 'signal'));
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, resolve);
    setTimeout(() => reject(new Error(`no answer to ${method}`)), 3000);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return { proc, call, get exited() { return exited; } };
}

test('메모 폴더가 사라져도(옮김·드라이브 빠짐) AI 비서 연결 서버가 멈추지 않고, 돌아오면 다시 읽음', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-'));
  const dir = path.join(base, 'vault');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '장보기.md'), '# 장보기\n\n우유\n');
  const s = connect(dir);
  try {
    await s.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const search = () => s.call('tools/call', { name: 'search_memos', arguments: {} });
    assert.match((await search()).result.content[0].text, /장보기/);

    fs.renameSync(dir, path.join(base, 'moved')); // 폴더를 옮김
    await new Promise((r) => setTimeout(r, 4500)); // 예전엔 4초마다 살피던 타이머가 여기서 서버를 멈췄다
    assert.equal(s.exited, null, '서버가 살아 있어야');
    const gone = await search();
    assert.equal(gone.result.isError, true);
    assert.match(gone.result.content[0].text, /폴더를 찾지 못했어요/);

    fs.renameSync(path.join(base, 'moved'), dir); // 돌아옴
    assert.match((await search()).result.content[0].text, /장보기/);
  } finally {
    s.proc.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('덧붙이기는 제목이 딱 맞는 메모에만, 빈 내용은 거절', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-'));
  const dir = path.join(base, 'vault');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '주말 장보기 목록.md'), '# 주말 장보기 목록\n\n- 달걀\n');
  fs.writeFileSync(path.join(dir, '일기.md'), '# 일기\n\n오늘 장보기를 했다\n');
  const s = connect(dir);
  try {
    await s.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tool = (name, args) => s.call('tools/call', { name, arguments: args }).then((r) => r.result);
    const miss = await tool('append_to_memo', { memo: '장보기', content: '- 우유' });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0].text, /비슷한 메모/);
    assert.ok(!fs.readFileSync(path.join(dir, '일기.md'), 'utf8').includes('우유'), '엉뚱한 메모를 고치지 않음');
    const ok = await tool('append_to_memo', { memo: '주말 장보기 목록', content: '- 우유' });
    assert.ok(!ok.isError);
    assert.match(fs.readFileSync(path.join(dir, '주말 장보기 목록.md'), 'utf8'), /- 우유/);
    const blank = await tool('create_memo', { content: '   ' });
    assert.equal(blank.isError, true);
    assert.match(blank.content[0].text, /비어 있어요/);
  } finally {
    s.proc.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('설정 파일을 읽지 못하면 AI 가 메모를 쓰지 못함 (읽기는 됨)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-'));
  const dir = path.join(base, 'vault');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '메모.md'), '# 메모\n\n글\n');
  const s = connect(dir, { settingsFile: path.join(base, 'none.json') });
  try {
    await s.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tool = (name, args) => s.call('tools/call', { name, arguments: args }).then((r) => r.result);
    assert.match((await tool('search_memos', {})).content[0].text, /메모/);
    const w = await tool('create_memo', { content: '# 새 메모' });
    assert.equal(w.isError, true);
  } finally {
    s.proc.kill();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
