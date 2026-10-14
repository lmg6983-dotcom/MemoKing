// 구글 로그인 (Google Drive 권한) — 기본 브라우저로 로그인하고, 이 PC 안 작은 서버(127.0.0.1)로 결과를 받는다.
// "데스크톱 앱" 유형 OAuth 클라이언트 + PKCE. Google Drive 데스크탑 앱이 없어도 된다.
//
// OAuth 클라이언트 ID·보안 비밀번호는 (먼저 찾는 순서) 설정에서 붙여 넣은 값 → 환경 변수 MEMOKING_GOOGLE_CLIENT_ID /
// MEMOKING_GOOGLE_CLIENT_SECRET → 앱에 함께 넣은 desktop/google-client.json ({ "id": "...", "secret": "..." }).
// 받은 토큰은 이 PC 에만 (%APPDATA%\MemoKing\google-auth.json), Windows 가 주는 암호화(safeStorage)로 감싸서 둔다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// 메모킹이 만든(또는 사용자가 메모킹으로 연) 파일·폴더만 — Drive 전체를 보지 않는다 (스토어 심사의 "제한 범위"가 아님).
// PC 메모킹과 휴대폰 메모킹은 같은 Google Cloud 프로젝트의 클라이언트라 서로 만든 메모를 본다
// Drive 전체 (drive.file 은 메모킹이 만든 파일만 보여 제미나이 등 다른 앱이 폴더에 넣은 메모가 보이지 않았다)
export const SCOPE = 'https://www.googleapis.com/auth/drive';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOGIN_TIMEOUT = 5 * 60 * 1000;

export class AuthError extends Error {}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class GoogleAuth {
  /**
   * @param {{ file: string, bundledClient?: string, fetch?: typeof fetch, openExternal: (url: string) => void,
   *           safeStorage?: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} options
   */
  constructor({ file, bundledClient, fetch: fetchImpl = fetch, openExternal, safeStorage }) {
    this.file = file;
    this.bundledClient = bundledClient;
    this.fetch = fetchImpl;
    this.openExternal = openExternal;
    this.safeStorage = safeStorage;
    this.data = this.load();
    // 예전(Drive 전체 권한)으로 로그인해 둔 것: 다시 연결하게 하고, 구글 쪽 예전 권한은 돌려준다
    this.scopeUpgraded = false;
    if (this.data.refreshToken && this.data.scope !== SCOPE) {
      const old = this.data.refreshToken;
      delete this.data.refreshToken;
      delete this.data.email;
      this.scopeUpgraded = true;
      try {
        this.save();
      } catch {
        // 다음에
      }
      this.post('https://oauth2.googleapis.com/revoke', { token: old }).catch(() => {});
    }
    this.accessToken = null;
    this.expiresAt = 0;
    this.pending = null; // 기다리는 로그인 서버
  }

  // ---------- 저장 ----------

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.encrypted && this.safeStorage?.isEncryptionAvailable()) {
        return JSON.parse(this.safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64')));
      }
      return raw.plain ?? {};
    } catch {
      return {};
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const json = JSON.stringify(this.data);
    const out = this.safeStorage?.isEncryptionAvailable()
      ? { encrypted: this.safeStorage.encryptString(json).toString('base64') }
      : { plain: this.data };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, this.file);
  }

  // ---------- OAuth 클라이언트 ----------

  bundled() {
    try {
      return this.bundledClient ? JSON.parse(fs.readFileSync(this.bundledClient, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  client() {
    if (this.data.clientId) return { id: this.data.clientId, secret: this.data.clientSecret ?? '' };
    if (process.env.MEMOKING_GOOGLE_CLIENT_ID) return { id: process.env.MEMOKING_GOOGLE_CLIENT_ID, secret: process.env.MEMOKING_GOOGLE_CLIENT_SECRET ?? '' };
    const b = this.bundled();
    return b?.id ? { id: b.id, secret: b.secret ?? '' } : null;
  }

  get configured() {
    return Boolean(this.client());
  }

  setClient(id, secret) {
    this.data.clientId = String(id ?? '').trim();
    this.data.clientSecret = String(secret ?? '').trim();
    this.save();
  }

  get connected() {
    return Boolean(this.data.refreshToken);
  }

  get email() {
    return this.data.email ?? '';
  }

  setEmail(email) {
    this.data.email = email;
    this.save();
  }

  // ---------- 로그인 ----------

  /** 기본 브라우저로 로그인 → 허용하면 토큰을 받아 둔다 */
  async login() {
    const client = this.client();
    if (!client) throw new AuthError('Google 로그인 설정(OAuth 클라이언트 ID)이 아직 없어요');
    this.cancelLogin();
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));

    const { code, redirect } = await new Promise((resolve, reject) => {
      let redirectUri = '';
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!url.searchParams.has('state')) {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.has('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(ok));
        finish(() => {
          const error = url.searchParams.get('error');
          if (url.searchParams.get('state') !== state) reject(new AuthError('로그인 확인 값이 맞지 않아요. 다시 시도해 주세요'));
          else if (!ok) reject(new AuthError(error === 'access_denied' ? '로그인을 취소했어요' : `로그인하지 못했어요 (${error})`));
          else resolve({ code: url.searchParams.get('code'), redirect: redirectUri });
        });
      });
      const timer = setTimeout(() => finish(() => reject(new AuthError('로그인을 기다리다 시간이 지났어요. 다시 시도해 주세요'))), LOGIN_TIMEOUT);
      const finish = (then) => {
        clearTimeout(timer);
        server.close();
        if (this.pending?.server === server) this.pending = null;
        then();
      };
      this.pending = { server, cancel: () => finish(() => reject(new AuthError('로그인을 취소했어요'))) };
      server.on('error', (err) => finish(() => reject(err)));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}`;
        const q = new URLSearchParams({
          client_id: client.id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
          code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
        });
        this.openExternal(`${AUTH_URL}?${q}`);
      });
    });

    const token = await this.post(TOKEN_URL, {
      code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (!token.refresh_token) throw new AuthError('구글이 오래 쓸 수 있는 권한을 주지 않았어요. 다시 시도해 주세요');
    this.data.refreshToken = token.refresh_token;
    this.data.scope = SCOPE;
    this.scopeUpgraded = false;
    this.accessToken = token.access_token;
    this.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
    this.save();
  }

  cancelLogin() {
    this.pending?.cancel();
  }

  /** 지금 쓸 수 있는 접근 토큰 (만료됐으면 새로 받음) */
  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    if (!this.data.refreshToken) throw new AuthError('Google Drive에 로그인해 주세요');
    const client = this.client();
    if (!client) throw new AuthError('Google 로그인 설정(OAuth 클라이언트 ID)이 없어요');
    this.refreshing ??= this.post(TOKEN_URL, {
      refresh_token: this.data.refreshToken, client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token',
    }).finally(() => {
      this.refreshing = null;
    });
    let token;
    try {
      token = await this.refreshing;
    } catch (err) {
      if (err instanceof AuthError) {
        // 권한을 거둬 갔거나 오래돼서 끊김 → 다시 로그인
        delete this.data.refreshToken;
        this.save();
        throw new AuthError('Google Drive 로그인이 끊겼어요. 설정에서 다시 연결해 주세요');
      }
      throw err;
    }
    this.accessToken = token.access_token;
    this.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  invalidate() {
    this.accessToken = null;
  }

  signOut() {
    const refresh = this.data.refreshToken;
    delete this.data.refreshToken;
    delete this.data.email;
    this.accessToken = null;
    this.save();
    if (refresh) this.post('https://oauth2.googleapis.com/revoke', { token: refresh }).catch(() => {});
  }

  async post(url, form) {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // 글자 응답
    }
    if (res.status >= 400 && res.status < 500) throw new AuthError(`Google 로그인 오류: ${json.error_description || json.error || text}`);
    if (!res.ok) throw new Error(`Google 서버 오류 (${res.status})`);
    return json;
  }
}

function page(ok) {
  const title = ok ? '메모킹에 Google Drive를 연결했어요' : '연결하지 못했어요';
  const sub = ok ? '이 창을 닫고 메모킹으로 돌아가세요.' : '메모킹으로 돌아가 다시 시도해 주세요.';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>메모킹</title>
<style>body{font-family:system-ui,"Malgun Gothic",sans-serif;background:#f6f5f1;color:#111;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}
h1{font-size:22px}p{color:#6b6860}</style></head><body><div><h1>${title}</h1><p>${sub}</p></div></body></html>`;
}
