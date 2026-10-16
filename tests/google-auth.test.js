// 데스크탑 구글 로그인 — 브라우저 대신 시험이 127.0.0.1 로 돌아오고, 구글 토큰 서버는 가짜 fetch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth, AuthError } from '../desktop/drive/google-auth.js';
import { DriveApi } from '../desktop/drive/drive-api.js';

function setup({ tokenResponse, deny = () => false } = {}) {
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
      if (deny(opened)) back.searchParams.set('error', 'access_denied'); // 허용 화면에서 취소
      else back.searchParams.set('code', 'CODE123');
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

test('권한: 메모킹이 만든 파일만(drive.file) 요청하고, 다른 범위로 저장된 예전 연결(Drive 전체 등)은 끊어 다시 연결하게', async () => {
  const { auth, dir, opened } = setup();
  auth.setClient('id-1.apps.googleusercontent.com', 'GOCSPX-s');
  await auth.login();
  assert.equal(opened().searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
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
  // 0.33.7~0.33.8 에서 Drive 전체로 연결해 둔 것은 끊지 않고 "외부 앱 메모 연동" 을 켠 것으로 이어 간다
  fs.writeFileSync(file, JSON.stringify({ plain: { clientId: 'id-1.apps.googleusercontent.com', refreshToken: 'WIDE', scope: 'https://www.googleapis.com/auth/drive' } }));
  const wide = new GoogleAuth({ file, openExternal: () => {}, fetch: async () => new Response('{}') });
  assert.equal(wide.connected, true);
  assert.equal(wide.scopeUpgraded, false);
  assert.equal(wide.fullScope, true);
});

const FULL = 'https://www.googleapis.com/auth/drive';
const FILE = 'https://www.googleapis.com/auth/drive.file';

test('외부 앱 메모 연동: 기본은 drive.file · 켜면 Drive 전체로 다시 로그인 · 껐다 켜도 앱을 다시 켜도 그대로', async () => {
  const scopes = [];
  const { auth, dir } = setup({ tokenResponse: (p) => ({ access_token: 'AT', refresh_token: `RT${scopes.length}`, expires_in: 3600, scope: scopes.at(-1) }) });
  auth.openExternal = ((open) => (url) => { scopes.push(new URL(url).searchParams.get('scope')); open(url); })(auth.openExternal);
  auth.setClient('id-1.apps.googleusercontent.com', 's');
  await auth.login();
  assert.equal(scopes.at(-1), FILE, '기본은 drive.file');
  assert.equal(auth.fullScope, false);
  const on = await auth.setFullScope(true);
  assert.deepEqual([on.full, on.relogged], [true, true]);
  assert.equal(scopes.at(-1), FULL, '켜면 Drive 전체를 요청');
  assert.equal(auth.fullScope, true);
  assert.equal(auth.grantedFull, true);
  // 앱을 다시 켜도 끊거나 낮추지 않는다
  const again = new GoogleAuth({ file: path.join(dir, 'google-auth.json'), openExternal: () => {} });
  assert.deepEqual([again.connected, again.fullScope, again.scopeUpgraded], [true, true, false]);
  // 다시 로그인(연결하기)해도 켜 둔 범위로
  await auth.login();
  assert.equal(scopes.at(-1), FULL);
  // 끄면 drive.file 로 다시 로그인
  const off = await auth.setFullScope(false);
  assert.deepEqual([off.full, off.relogged], [false, true]);
  assert.equal(scopes.at(-1), FILE);
  assert.deepEqual([auth.fullScope, auth.grantedFull, auth.connected], [false, false, true]);
});

test('외부 앱 메모 연동: 허용 화면에서 취소하거나 Drive 전체 칸을 빼고 허용하면 꺼진 채, 지금 연결은 그대로', async () => {
  let cancel = false;
  let grant = FILE;
  const { auth } = setup({
    deny: () => cancel,
    tokenResponse: () => ({ access_token: 'AT', refresh_token: grant === FILE ? 'RT-FILE' : 'RT-OTHER', expires_in: 3600, scope: grant }),
  });
  auth.setClient('id-1.apps.googleusercontent.com', 's');
  await auth.login();
  const before = auth.data.refreshToken;
  cancel = true;
  const res = await auth.setFullScope(true);
  assert.equal(res.full, false);
  assert.match(res.error, /취소/);
  assert.deepEqual([auth.fullScope, auth.connected, auth.data.refreshToken, auth.data.scope], [false, true, before, FILE], '취소: 그대로');
  cancel = false;
  grant = FILE; // 허용은 했지만 Drive 전체 칸을 뺐다
  const partial = await auth.setFullScope(true);
  assert.equal(partial.full, false);
  assert.match(partial.error, /허용하지 않았어요/);
  assert.deepEqual([auth.fullScope, auth.data.refreshToken], [false, before]);
});

test('외부 앱 메모 연동 끄기: 다시 로그인을 취소해도 설정은 꺼지고, 다음 연결은 drive.file', async () => {
  let cancel = false;
  const scopes = [];
  const { auth } = setup({ deny: (u) => { scopes.push(u.searchParams.get('scope')); return cancel; }, tokenResponse: () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: scopes.at(-1) }) });
  auth.setClient('id-1.apps.googleusercontent.com', 's');
  await auth.setFullScope(true);
  assert.equal(auth.fullScope, true);
  cancel = true;
  const off = await auth.setFullScope(false);
  assert.deepEqual([off.full, off.relogged], [false, false]);
  assert.equal(auth.fullScope, false);
  assert.equal(auth.connected, true, '지금 연결은 그대로');
  cancel = false;
  await auth.login();
  assert.equal(scopes.at(-1), FILE);
});

test('로그인한 클라이언트를 기억: 연결 정보 없이 빌드된 새 버전으로 업데이트돼도 연결 · 새 토큰 · 다시 로그인이 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-auth-'));
  const bundled = path.join(dir, 'google-client.json');
  fs.writeFileSync(bundled, JSON.stringify({ id: 'built-in.apps.googleusercontent.com', secret: 'GOCSPX-b' }));
  const file = path.join(dir, 'google-auth.json');
  const posts = [];
  const fakeFetch = async (url, init) => {
    posts.push(Object.fromEntries(new URLSearchParams(init.body)));
    return new Response(JSON.stringify({ access_token: `AT${posts.length}`, refresh_token: 'RT1', expires_in: 3600 }), { status: 200 });
  };
  const openExternal = (url) => {
    const o = new URL(url);
    const back = new URL(o.searchParams.get('redirect_uri'));
    back.searchParams.set('state', o.searchParams.get('state'));
    back.searchParams.set('code', 'C');
    setTimeout(() => fetch(back).catch(() => {}), 10);
  };
  const first = new GoogleAuth({ file, bundledClient: bundled, fetch: fakeFetch, openExternal });
  await first.login();
  // 새 버전: 함께 넣은 연결 정보가 없다
  const updated = new GoogleAuth({ file, bundledClient: path.join(dir, 'none.json'), fetch: fakeFetch, openExternal });
  assert.equal(updated.configured, true);
  assert.equal(updated.connected, true);
  await updated.token();
  assert.equal(posts.at(-1).grant_type, 'refresh_token');
  assert.equal(posts.at(-1).client_id, 'built-in.apps.googleusercontent.com');
  updated.signOut();
  assert.equal(updated.configured, true, '연결을 끊어도 다시 로그인할 수 있게');
});

test('예전 연결(클라이언트를 적어 두지 않음)도 켤 때 지금 클라이언트를 기억 · 연결 정보는 여러 곳 중 처음 찾은 것', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoking-auth-'));
  const file = path.join(dir, 'google-auth.json');
  fs.writeFileSync(file, JSON.stringify({ plain: { refreshToken: 'RT-old', scope: 'https://www.googleapis.com/auth/drive.file' } }));
  const user = path.join(dir, 'user-client.json');
  fs.writeFileSync(user, JSON.stringify({ id: 'user.apps.googleusercontent.com', secret: 's' }));
  const old = new GoogleAuth({ file, bundledClient: [path.join(dir, 'missing.json'), user], openExternal: () => {} });
  assert.equal(old.client().id, 'user.apps.googleusercontent.com');
  const later = new GoogleAuth({ file, bundledClient: path.join(dir, 'missing.json'), openExternal: () => {} });
  assert.equal(later.connected, true);
  assert.equal(later.refreshClient().id, 'user.apps.googleusercontent.com');
});
