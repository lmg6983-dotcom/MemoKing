// app/vendor/noble-crypto.js 로 묶일 암호 (npm run vendor) — 잠금 메모 (core/memo-lock.js)
//   감사받은 순수 JS 구현이라 PC 메인 프로세스·휴대폰 화면·AI 비서 연결 어디서나 같은 결과, 저장은 동기로 (창을 닫는 순간에도)
export { gcm } from '@noble/ciphers/aes.js';
export { pbkdf2, pbkdf2Async } from '@noble/hashes/pbkdf2.js';
export { sha256 } from '@noble/hashes/sha2.js';
