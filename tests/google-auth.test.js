// 데스크탑 구글 로그인 — 브라우저 대신 시험이 127.0.0.1 로 돌아오고, 구글 토큰 서버는 가짜 fetch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth, AuthError } from '../desktop/drive/google-auth.js';
import { DriveApi } from '../desktop/drive/drive-api.js';

function setup({ tokenResponse } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-auth-'));
  const posts = [];
  const fakeFetch = async (url, init) => {
    posts.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    const body = typeof tokenResponse === 'function' ? tokenResponse(posts.at(-1)) : { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 };
    return new Response(JSON.stringify(body.error ? { error: body.error } : body), { status: body.error ? 400 : 200 });
  };
  let opened = null;
  const auth = new GoogleAuth({
    file: path.join(dir, 'google-auth.json'),
    fetch: fakeFetch,
    // 브라우저 대신: 로그인 주소를 받아 허용한 것처럼 127.0.0.1 로 돌아온다
    openExternal: (url) => {
      opened = new URL(url);
      const back = new URL(opened.searchParams.get('redirect_uri'));
      back.searchParams.set('state', opened.searchParams.get('state'));
      back.searchParams.set('code', 'CODE123');
      setTimeout(() => fetch(back).catch(() => {}), 10);
    },
  });
  return { auth, posts, dir, opened: () => opened };
}

test('설정이 없으면 로그인할 수 없음', async () => {
  const { auth } = setup();
  assert.equal(auth.configured, false);
  await assert.rejects(auth.login(), AuthError);
});

test('브라우저 로그인 → 코드 → 토큰 (PKCE), 저장한 뒤 다시 읽음', async () => {
  const { auth, posts, dir, opened } = setup();
  auth.setClient('id-1.apps.googleusercontent.com', 'GOCSPX-s');
  await auth.login();
  const o = opened();
  assert.equal(o.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(o.searchParams.get('access_type'), 'offline');
  assert.match(o.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  const exchange = posts[0].body;
  assert.equal(exchange.code, 'CODE123');
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.ok(exchange.code_verifier.length >= 43);
  assert.equal(await auth.token(), 'AT1');
  assert.equal(auth.connected, true);
  const again = new GoogleAuth({ file: path.join(dir, 'google-auth.json'), openExternal: () => {} });
  assert.equal(again.connected, true);
  assert.equal(again.client().id, 'id-1.apps.googleusercontent.com');
});

test('접근 토큰이 만료되면 refresh 로 새로, 거부되면 연결 끊김', async () => {
  let refreshOk = true;
  const { auth } = setup({
    tokenResponse: (p) => (p.body.grant_type === 'refresh_token'
      ? (refreshOk ? { access_token: 'AT2', expires_in: 3600 } : { error: 'invalid_grant' })
      : { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 }),
  });
  auth.setClient('id', 's');
  await auth.login();
  auth.invalidate();
  assert.equal(await auth.token(), 'AT2');
  auth.invalidate();
  refreshOk = false;
  await assert.rejects(auth.token(), /로그인이 끊겼어요/);
  assert.equal(auth.connected, false);
});

test('Drive 올리기: resumable 시작 → 주소로 내용 보내기, 401 이면 토큰 새로', async () => {
  const calls = [];
  let first = true;
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers });
    if (first && String(url).includes('uploadType=resumable')) {
      first = false;
      return new Response('{}', { status: 401 });
    }
    if (String(url).includes('uploadType=resumable')) return new Response('{}', { status: 200, headers: { Location: 'https://upload.example/session1' } });
    if (String(url) === 'https://upload.example/session1') {
      return new Response(JSON.stringify({ id: 'F1', name: 'a.md', mimeType: 'text/markdown', md5Checksum: 'abc', modifiedTime: '2026-10-03T00:00:00.000Z', size: '3' }));
    }
    return new Response('{}', { status: 404 });
  };
  let tokens = 0;
  const auth = { token: async () => `T${++tokens}`, invalidate: () => {} };
  const api = new DriveApi({ auth, fetch: fakeFetch });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-up-')), 'a.md');
  fs.writeFileSync(file, 'abc');
  const item = await api.upload('PARENT', 'a.md', null, file);
  assert.deepEqual([item.id, item.md5, item.size], ['F1', 'abc', 3]);
  assert.equal(calls[1].headers.Authorization, 'Bearer T2');
  assert.equal(calls[1].headers['X-Upload-Content-Length'], '3');
  assert.equal(calls[2].method, 'PUT');
});

test('권한: Drive 전체(drive)를 요청하고, 다른 범위로 저장된 예전 연결(drive.file 등)은 끊어 다시 연결하게', async () => {
  const { auth, dir, opened } = setup();
  auth.setClient('id-1.apps.googleusercontent.com', 'GOCSPX-s');
  await auth.login();
  assert.equal(opened().searchParams.get('scope'), 'https://www.googleapis.com/auth/drive');
  const file = path.join(dir, 'google-auth.json');
  // 같은 범위로 저장된 연결은 그대로
  assert.equal(new GoogleAuth({ file, openExternal: () => {}, fetch: async () => new Response('{}') }).connected, true);
  // 예전 버전이 저장한 연결 (범위 표시 없음) → 끊고, 구글 쪽 권한은 돌려준다
  fs.writeFileSync(file, JSON.stringify({ plain: { clientId: 'id-1.apps.googleusercontent.com', refreshToken: 'OLD', email: 'a@b.com' } }));
  const revoked = [];
  const old = new GoogleAuth({ file, openExternal: () => {}, fetch: async (url, init) => { revoked.push([url, String(init.body)]); return new Response('{}'); } });
  assert.equal(old.connected, false);
  assert.equal(old.scopeUpgraded, true);
  assert.equal(old.client().id, 'id-1.apps.googleusercontent.com'); // 연결 정보는 남김
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(revoked.some(([url, body]) => url.includes('/revoke') && body.includes('OLD')));
  assert.equal(new GoogleAuth({ file, openExternal: () => {} }).scopeUpgraded, false); // 한 번만
  // drive.file 로 연결해 둔 것(0.18.14 ~ 0.33.x)도 끊고 다시 연결하게 — 다른 앱이 넣은 메모가 보이도록
  fs.writeFileSync(file, JSON.stringify({ plain: { clientId: 'id-1.apps.googleusercontent.com', refreshToken: 'NARROW', scope: 'https://www.googleapis.com/auth/drive.file' } }));
  const narrow = new GoogleAuth({ file, openExternal: () => {}, fetch: async () => new Response('{}') });
  assert.equal(narrow.connected, false);
  assert.equal(narrow.scopeUpgraded, true);
});
