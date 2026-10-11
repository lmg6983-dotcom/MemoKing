import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SERVER = path.join(import.meta.dirname, '..', 'desktop', 'mcp-server.js');

/** 표준 입출력으로 MCP 서버와 주고받기 */
function connect(vaultDir) {
  const proc = spawn(process.execPath, [SERVER, '--vault', vaultDir, '--settings', path.join(vaultDir, '..', 'none.json')], { stdio: ['pipe', 'pipe', 'pipe'] });
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
