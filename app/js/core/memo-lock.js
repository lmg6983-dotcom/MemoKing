// 잠금 메모 — 메모 내용을 비밀번호로 암호화해 파일에 둔다 (PC·휴대폰·AI 비서 연결 같은 규칙, 순수 함수 + WebCrypto).
//   파일 모양: 제목 줄(목록에 보이도록) + 안내 한 줄 + 암호문 한 줄(HTML 주석 — 다른 마크다운 앱에서도 깨지지 않음)
//     # 제목
//
//     🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.
//
//     <!-- memoking-lock v1 n=310000 s=<소금> i=<IV> c=<암호문> -->
//   PBKDF2-SHA256(비밀번호, 소금, n 번) → AES-GCM 256. 비밀번호는 어디에도 저장하지 않는다 (잊으면 되찾을 수 없음).
//   제목만 보인다 — 본문·태그·첨부 경로는 암호문 안에. (첨부 파일 자체는 암호화하지 않음: 화면에 그렇게 알린다)
import { extractTitle, UNTITLED } from './memo-file.js';

export const LOCK_VERSION = 'v1';
export const LOCK_ITERATIONS = 310_000;
export const LOCK_NOTICE = '🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.';
const LOCK_RE = /<!--\s*memoking-lock\s+(v\d+)\s+n=(\d+)\s+s=([A-Za-z0-9+/=]+)\s+i=([A-Za-z0-9+/=]+)\s+c=([A-Za-z0-9+/=]+)\s*-->/;

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
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('이 기기에서는 암호화를 쓸 수 없어요');
  return s;
};

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** 비밀번호 규칙: 4자 이상 */
export function passwordProblem(password) {
  if (String(password ?? '').length < 4) return '비밀번호는 4자 이상으로 정해 주세요';
  return null;
}

/** 본문 → 잠긴 본문 */
export async function lockBody(body, password, { iterations = LOCK_ITERATIONS } = {}) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(body))));
  const title = extractTitle(body);
  const head = title && title !== UNTITLED ? `# ${title.replace(/^#+\s*/, '')}\n\n` : '';
  return `${head}${LOCK_NOTICE}\n\n<!-- memoking-lock ${LOCK_VERSION} n=${iterations} s=${b64(salt)} i=${b64(iv)} c=${b64(data)} -->\n`;
}

/** 잠긴 본문 → 원래 본문. 비밀번호가 다르면 예외 */
export async function unlockBody(lockedBody, password) {
  const p = parseLocked(lockedBody);
  if (!p) throw new Error('잠긴 메모가 아니에요');
  if (p.version !== LOCK_VERSION) throw new Error('이 메모킹보다 새 버전에서 잠근 메모예요. 메모킹을 업데이트해 주세요');
  const key = await deriveKey(password, unb64(p.salt), p.iterations);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(p.iv) }, key, unb64(p.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('비밀번호가 달라요');
  }
}
