// 구글 로그인 (Google Drive 권한) — 기본 브라우저로 로그인하고, 이 PC 안 작은 서버(127.0.0.1)로 결과를 받는다.
// "데스크톱 앱" 유형 OAuth 클라이언트 + PKCE. Google Drive 데스크탑 앱이 없어도 된다.
//
// OAuth 클라이언트 ID·보안 비밀번호는 (먼저 찾는 순서) 설정에서 붙여 넣은 값 → 환경 변수 MEMOKING_GOOGLE_CLIENT_ID /
// MEMOKING_GOOGLE_CLIENT_SECRET → 앱에 함께 넣은 desktop/google-client.json ({ "id": "...", "secret": "..." }) 또는 %APPDATA%\MemoKing\google-client.json
// → 예전에 로그인했던 클라이언트.
// 로그인에 쓴 클라이언트는 토큰과 함께 기억해 둔다 (tokenClient) — 연결 정보 없이 빌드된 새 버전으로 업데이트돼도
// 연결이 끊기지 않고, 구글이 그 토큰을 준 클라이언트로만 새 토큰을 받는다.
// 받은 토큰은 이 PC 에만 (%APPDATA%\MemoKing\google-auth.json), Windows 가 주는 암호화(safeStorage)로 감싸서 둔다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { UI } from '../../app/js/core/ui-text.js';

// 기본: 메모킹이 만든(또는 사용자가 메모킹으로 연) 파일·폴더만 — Drive 전체를 보지 않는다 (스토어 심사의 "제한 범위"가 아님).
//   PC 메모킹과 휴대폰 메모킹은 같은 Google Cloud 프로젝트의 클라이언트라 서로 만든 메모를 본다
export const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
// Drive 전체 — 더는 요청하지 않는다. 예전 "외부 앱 메모 연동" 으로 받아 둔 연결만 끊지 않고 쓰다가, 다시 로그인하면 drive.file
export const FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
export const SCOPE = FILE_SCOPE;
const KNOWN_SCOPES = new Set([FILE_SCOPE, FULL_SCOPE]);
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOGIN_TIMEOUT = 5 * 60 * 1000;

export class AuthError extends Error {}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class GoogleAuth {
  /**
   * @param {{ file: string, bundledClient?: string | string[], fetch?: typeof fetch, openExternal: (url: string) => void,
   *           safeStorage?: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} options
   */
  constructor({ file, bundledClient, fetch: fetchImpl = fetch, openExternal, safeStorage, scope = null, fallbackClient = null }) {
    this.file = file;
    // scope: 정해진 권한 하나만 (Google 캘린더 동기화 — Drive 연결과 따로 로그인). 없으면 Drive (drive.file / 전체)
    this.fixedScope = scope;
    this.fallbackClient = fallbackClient; // 붙여 넣은 · 함께 넣은 연결 정보가 없을 때 빌려 쓸 클라이언트 (Drive 연결의 것)
    this.label = scope ? UI.googleCalendar : 'Google Drive';
    this.bundledClient = bundledClient;
    this.fetch = fetchImpl;
    this.openExternal = openExternal;
    this.safeStorage = safeStorage;
    this.data = this.load();
    // 범위 표시가 없는 아주 예전 연결만: 다시 연결하게 하고, 구글 쪽 예전 권한은 돌려준다.
    //   drive.file · 예전 Drive 전체 연결은 그대로 — 앱을 켤 때마다 끊지 않는다
    this.scopeUpgraded = false;
    if (!scope && this.data.refreshToken && !KNOWN_SCOPES.has(this.data.scope)) {
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
    // 예전 연결(로그인한 클라이언트를 적어 두지 않은 것): 지금 쓸 수 있는 클라이언트가 그 클라이언트 — 기억해 둔다
    if (this.data.refreshToken && !this.data.tokenClient?.id) {
      const c = this.client();
      if (c) {
        this.data.tokenClient = c;
        try {
          this.save();
        } catch {
          // 다음에
        }
      }
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

  /** 앱에 함께 넣은 연결 정보 — 여러 곳이면 처음 찾은 것 (설치 폴더 · %APPDATA%\MemoKing 에 둔 파일) */
  bundled() {
    for (const file of [this.bundledClient].flat().filter(Boolean)) {
      try {
        const b = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (b?.id) return b;
      } catch {
        // 없거나 깨짐 — 다음 곳
      }
    }
    return null;
  }

  client() {
    if (this.data.clientId) return { id: this.data.clientId, secret: this.data.clientSecret ?? '' };
    if (process.env.MEMOKING_GOOGLE_CLIENT_ID) return { id: process.env.MEMOKING_GOOGLE_CLIENT_ID, secret: process.env.MEMOKING_GOOGLE_CLIENT_SECRET ?? '' };
    const b = this.bundled();
    if (b?.id) return { id: b.id, secret: b.secret ?? '' };
    // 연결 정보 없이 빌드된 버전: 예전에 로그인했던 클라이언트로 (다시 로그인도 같은 클라이언트로)
    const t = this.data.tokenClient;
    if (t?.id) return { id: t.id, secret: t.secret ?? '' };
    const f = this.fallbackClient?.();
    return f?.id ? f : null;
  }

  /** 지금 클라이언트가 어디서 왔나 — 'manual'(설정에 붙여 넣음) | 'env' | 'bundled'(앱에 넣어 둔 것) | 'remembered'(예전 로그인) | 'fallback' */
  clientSource() {
    if (this.data.clientId) return 'manual';
    if (process.env.MEMOKING_GOOGLE_CLIENT_ID) return 'env';
    if (this.bundled()?.id) return 'bundled';
    if (this.data.tokenClient?.id) return 'remembered';
    return 'fallback';
  }

  /** 새 토큰을 받을 클라이언트 — 그 토큰을 준 클라이언트 (기억해 둔 게 없으면 지금 클라이언트) */
  refreshClient() {
    const t = this.data.tokenClient;
    return t?.id ? { id: t.id, secret: t.secret ?? '' } : this.client();
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

  /** 지금 받아 둔 권한이 Drive 전체인가 (예전 외부 앱 메모 연동 — 동기화가 drive.file 로 줄 때 메모를 지우지 않게) */
  get grantedFull() {
    return Boolean(this.data.refreshToken) && this.data.scope === FULL_SCOPE;
  }

  setEmail(email) {
    this.data.email = email;
    this.save();
  }

  // ---------- 로그인 ----------

  /**
   * 기본 브라우저로 로그인 → 허용하면 토큰을 받아 둔다. 취소·실패하면 지금 연결(토큰·설정)은 그대로.
   */
  async login() {
    const scope = this.fixedScope ?? FILE_SCOPE;
    const client = this.client();
    if (!client) throw new AuthError('Google 로그인 설정(연결 ID, 비밀번호)이 아직 없어요. 설정 Google Drive 동기화의 연결하기에서 안내서(DRIVE-SETUP)대로 만든 값을 넣어 주세요');
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(ok, this.label));
        finish(() => {
          const error = url.searchParams.get('error');
          if (url.searchParams.get('state') !== state) reject(new AuthError('로그인 확인 값이 맞지 않아요. 다시 해 주세요'));
          else if (!ok) reject(new AuthError(error === 'access_denied' ? '로그인을 취소했어요' : `로그인하지 못했어요 (${error})`));
          else resolve({ code: url.searchParams.get('code'), redirect: redirectUri });
        });
      });
      const timer = setTimeout(() => finish(() => reject(new AuthError('로그인을 기다리다 시간이 지났어요. 다시 해 주세요'))), LOGIN_TIMEOUT);
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
          client_id: client.id, redirect_uri: redirectUri, response_type: 'code', scope,
          code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
        });
        this.openExternal(`${AUTH_URL}?${q}`);
      });
    });

    const source = this.clientSource();
    const token = await this.post(TOKEN_URL, {
      code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier,
    }).catch((err) => {
      throw invalidClientHelp(err, source) ?? err;
    });
    if (!token.refresh_token) throw new AuthError('구글이 오래 쓸 수 있는 권한을 주지 않았어요. 다시 해 주세요');
    const granted = String(token.scope ?? scope).split(/\s+/);
    if (this.fixedScope && token.scope && !granted.includes(this.fixedScope)) throw new AuthError(`${this.label} 권한을 허용하지 않았어요. 허용 화면에서 칸을 켜고 다시 해 주세요`);
    this.data.refreshToken = token.refresh_token;
    this.data.scope = scope;
    delete this.data.useFullDriveScope; // 예전 외부 앱 메모 연동 설정
    this.data.tokenClient = { id: client.id, secret: client.secret };
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
    if (!this.data.refreshToken) throw new AuthError(`${this.label}에 로그인해 주세요`);
    const client = this.refreshClient();
    if (!client) throw new AuthError('Google 로그인 설정(연결 ID, 비밀번호)이 없어요. 설정 Google Drive 동기화의 연결하기에서 다시 넣어 주세요');
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
        throw new AuthError(`${this.label} 로그인이 끊겼어요. 다시 연결해 주세요`);
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

  /**
   * 연결 끊기. revoke: 구글 쪽 허용도 거둘지 — 같은 OAuth 클라이언트로 받은 다른 연결(Drive ↔ 캘린더)이 남아 있으면
   * 거두지 않는다 (구글은 클라이언트 · 계정의 허용을 통째로 거둬 다른 연결까지 끊긴다)
   */
  signOut({ revoke = true } = {}) {
    const refresh = this.data.refreshToken;
    delete this.data.refreshToken;
    delete this.data.email;
    this.accessToken = null;
    this.save();
    if (refresh && revoke) this.post('https://oauth2.googleapis.com/revoke', { token: refresh }).catch(() => {});
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
    if (!res.ok) throw new Error(`Google 서버에 문제가 있어요 (${res.status}). 잠시 뒤 다시 해 주세요`);
    return json;
  }
}

/** "client secret is invalid" 같은 클라이언트 오류 → 어디를 고쳐야 하는지 알려 주는 안내 (아니면 null) */
export function invalidClientHelp(err, source) {
  if (!(err instanceof AuthError) || !/invalid_client|client secret is invalid|client_secret|Unauthorized|The OAuth client was not found/i.test(err.message)) return null;
  const where = {
    manual: '설정에 붙여 넣은 클라이언트 ID, 보안 비밀번호가 서로 맞지 않아요. 설정의 Google Drive 의 클라이언트를 삭제하거나 같은 클라이언트의 값으로 다시 붙여 넣어 주세요 (삭제하면 앱에 들어 있는 연결 정보를 써요)',
    bundled: '이 앱에 들어 있는 Google 연결 정보(보안 비밀번호)가 맞지 않아요. 배포할 때 넣는 MEMOKING_GOOGLE_CLIENT_ID, MEMOKING_GOOGLE_CLIENT_SECRET 이 같은 클라이언트의 값인지 확인하고 다시 배포해야 해요',
    env: '환경 변수 MEMOKING_GOOGLE_CLIENT_ID, MEMOKING_GOOGLE_CLIENT_SECRET 이 서로 맞지 않아요',
    remembered: '예전에 로그인했던 클라이언트의 보안 비밀번호가 더 이상 맞지 않아요. 설정에서 클라이언트를 새로 붙여 넣어 주세요',
  }[source] ?? 'Google 클라이언트(ID, 보안 비밀번호)를 확인해 주세요';
  return new AuthError(`Google 로그인 오류: 클라이언트 보안 비밀번호가 올바르지 않아요. ${where}. (원문: ${err.message.replace(/^Google 로그인 오류: /, '')})`);
}

function page(ok, label = 'Google Drive') {
  const title = ok ? `메모킹에 ${label}를 연결했어요` : '연결하지 못했어요';
  const sub = ok ? '이 창을 닫고 메모킹으로 돌아가세요.' : '메모킹으로 돌아가 다시 해 주세요.';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>메모킹</title>
<style>body{font-family:system-ui,"Malgun Gothic",sans-serif;background:#f6f5f1;color:#111;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center}
h1{font-size:22px}p{color:#6b6860}</style></head><body><div><h1>${title}</h1><p>${sub}</p></div></body></html>`;
}
