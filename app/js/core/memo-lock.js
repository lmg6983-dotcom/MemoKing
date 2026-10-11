// 잠금 메모 — 메모 내용을 비밀번호로 암호화해 파일에 둔다 (PC·휴대폰·AI 비서 연결 같은 규칙).
//   파일 모양: 제목 줄(목록에 보이도록) + 안내 한 줄 + 암호문 한 줄(HTML 주석 — 다른 마크다운 앱에서도 깨지지 않음)
//     # 제목
//
//     🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.
//
//     <!-- memoking-lock v1 n=310000 s=<소금> i=<IV> c=<암호문+태그> -->
//   PBKDF2-SHA256(비밀번호, 소금, n 번) → AES-256-GCM. 비밀번호는 어디에도 저장하지 않는다 (잊으면 되찾을 수 없음).
//   암호는 noble(MIT, 감사받은 순수 JS) — 열쇠 만들기(느림)는 비동기, 열쇠로 잠그고 풀기(빠름)는 동기라
//   자동 저장·창 닫기 저장이 늘 잠근 글만 쓴다. 한 번 연 메모는 "세션"(열쇠·소금)을 들고 있다가 저장마다 새 IV 로 잠근다.
//   제목만 보인다 — 본문·태그·첨부 경로는 암호문 안에. (첨부 파일 자체는 암호화하지 않음: 화면에 그렇게 알린다)
import { gcm, pbkdf2Async, sha256 } from '../../vendor/noble-crypto.js';
import { extractTitle, extractAttachments, UNTITLED } from './memo-file.js';

export const LOCK_VERSION = 'v1';
export const LOCK_ITERATIONS = 310_000;
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 2_000_000;
export const LOCKED_TITLE = '잠긴 메모';
export const LOCK_NOTICE = '🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.';
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 잠긴 메모 파일의 본문 전체 모양: (제목 줄) (안내 한 줄) 암호문 주석 — 그 밖의 글이 있으면 잠긴 메모가 아니다
// (암호문 주석을 붙여 넣은 보통 메모가 잠긴 메모로 오인돼 열 수도 고칠 수도 없게 되는 일이 없게)
const LOCK_RE = new RegExp(
  `^\\uFEFF?\\s*(?:#[^\\n]*\\n\\s*)?(?:${escapeRe(LOCK_NOTICE)}\\s*)?`
  + '<!--\\s*memoking-lock\\s+(v\\d+)\\s+n=(\\d+)\\s+s=([A-Za-z0-9+/=]+)\\s+i=([A-Za-z0-9+/=]+)\\s+c=([A-Za-z0-9+/=]+)\\s*-->\\s*$',
);

export const isLockedBody = (body) => LOCK_RE.test(String(body ?? ''));

/** 잠긴 본문의 암호 조각 (잠긴 메모가 아니면 null) */
export function parseLocked(body) {
  const m = LOCK_RE.exec(String(body ?? ''));
  if (!m) return null;
  return { version: m[1], iterations: Number(m[2]), salt: m[3], iv: m[4], data: m[5] };
}

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** 비밀번호 규칙: 4자 이상 */
export function passwordProblem(password) {
  if (String(password ?? '').length < 4) return '비밀번호는 4자 이상으로 정해 주세요';
  return null;
}

async function deriveKey(password, salt, iterations) {
  return pbkdf2Async(sha256, new TextEncoder().encode(String(password).normalize('NFC')), salt, { c: iterations, dkLen: 32 });
}

/**
 * 새로 잠글 때의 세션 (새 소금)
 * @returns {Promise<{ key: Uint8Array, salt: string, iterations: number }>}
 */
export async function newLockSession(password, { iterations = LOCK_ITERATIONS } = {}) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = random(16);
  return { key: await deriveKey(password, salt, iterations), salt: b64(salt), iterations };
}

/** 잠긴 메모 열기: 비밀번호가 맞으면 { plain, session } — 다르면 예외 */
export async function openLock(lockedBody, password) {
  const p = parseLocked(lockedBody);
  if (!p) throw new Error('잠긴 메모가 아니에요');
  if (p.version !== LOCK_VERSION) throw new Error('이 메모킹보다 새 버전에서 잠근 메모예요. 메모킹을 업데이트해 주세요');
  // 파일에 적힌 반복 횟수를 그대로 믿지 않는다 (망가지거나 고쳐진 값으로 몇 시간씩 멈추거나 영영 못 열지 않게)
  if (!(p.iterations >= MIN_ITERATIONS && p.iterations <= MAX_ITERATIONS)) throw new Error('잠금 정보가 망가진 메모예요. 열 수 없어요');
  const session = { key: await deriveKey(password, unb64(p.salt), p.iterations), salt: p.salt, iterations: p.iterations };
  const plain = unsealBody(lockedBody, session);
  if (plain == null) throw new Error('비밀번호가 달라요');
  return { plain, session };
}

/**
 * 세션 열쇠로 잠근 본문 (동기 — 저장마다 새 IV)
 * hideTitle: 제목도 숨긴다 (목록·파일 이름에 "잠긴 메모") — 잠글 때 사용자가 고르고 머리말 lockHideTitle 에 남는다
 */
export function sealBody(plain, session, { hideTitle = false } = {}) {
  const iv = random(12);
  const data = gcm(session.key, iv).encrypt(new TextEncoder().encode(String(plain)));
  // 목록에 보일 제목(첫 줄) — 숨기기를 골랐거나 제목이 없으면 "잠긴 메모"
  // (제목 줄이 늘 있어야 안내 문구가 제목·파일 이름이 되지 않는다)
  const title = hideTitle ? '' : extractTitle(String(plain));
  const head = `# ${title && title !== UNTITLED ? title.replace(/^#+\s*/, '') : LOCKED_TITLE}\n\n`;
  return `${head}${LOCK_NOTICE}\n\n<!-- memoking-lock ${LOCK_VERSION} n=${session.iterations} s=${session.salt} i=${b64(iv)} c=${b64(data)} -->\n`;
}

/** 세션 열쇠로 푼 본문 (동기). 열쇠가 맞지 않으면(다른 기기에서 다른 비밀번호로 다시 잠금 등) null */
export function unsealBody(lockedBody, session) {
  const p = parseLocked(lockedBody);
  if (!p || p.salt !== session.salt || p.iterations !== session.iterations) return null;
  try {
    return new TextDecoder().decode(gcm(session.key, unb64(p.iv)).decrypt(unb64(p.data)));
  } catch {
    return null;
  }
}

// ---------- 잠긴 메모가 쓰는 첨부 ----------
// 첨부 경로는 암호문 안에만 있으므로, 첨부 정리(지운 메모의 사진 치우기)가 잠긴 메모의 사진을 치우지 않도록
// 머리말 lockRefs 에 "경로 + 그 메모의 소금" 해시만 적어 둔다 (경로 자체는 드러나지 않음)
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const lockRefKey = (src, salt) => hex(sha256(new TextEncoder().encode(`${salt}\n${src}`))).slice(0, 20);

/** 잠근 글(lockedBody)과 그 풀린 글(plain)로 머리말에 적을 표들 */
export function lockRefs(plain, lockedBody) {
  const p = parseLocked(lockedBody);
  return p ? [...new Set(extractAttachments(plain))].map((src) => lockRefKey(src, p.salt)) : [];
}


/** 한 번에 잠그기 (테스트·간단한 쓰임) */
export async function lockBody(plain, password, o = {}) {
  return sealBody(plain, await newLockSession(password, o), o);
}

/** 한 번에 풀기 */
export async function unlockBody(lockedBody, password) {
  return (await openLock(lockedBody, password)).plain;
}
