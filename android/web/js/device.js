// 이 휴대폰의 기기 상태 파일 (_memoking/기기/<이름> (<id>).md — app/js/core/devices.js, PC 는 desktop-rs/app/src/devices.rs)
//   동기화를 마칠 때마다 적고(바뀐 것이 있거나 5분마다), AI 받은함 시트를 이 휴대폰이 처리할 차례인지 정한다 (켜져 있는 PC 가 있으면 PC 가)
import { DEVICES_DIR, deviceFile, deviceText, parseDevice, inboxLeader, needsWrite } from '../../app/js/core/devices.js';
import { fs, native } from './native.js';

const KEY = 'memoking.deviceId';
function me() {
  let id = '';
  try {
    id = localStorage.getItem(KEY) ?? '';
    if (!id) localStorage.setItem(KEY, (id = Math.random().toString(16).slice(2, 6).padEnd(4, '0')));
  } catch {
    id ||= '0000';
  }
  const name = native.info()?.model || '휴대폰';
  return { name, file: deviceFile(name, id) };
}

/** 동기화 소식(st: { state, lastSync, error }) 뒤에 */
export function writeDevice(st, folder) {
  if (st.state !== 'idle' && st.state !== 'error') return;
  const { name, file } = me();
  const now = Date.now();
  const prev = fs.readText(file);
  const d = { name, kind: 'phone', lastSync: st.state === 'idle' ? st.lastSync || now : parseDevice(prev)?.lastSync, folder, error: st.state === 'error' ? st.error : '' };
  if (needsWrite(prev, d, now)) fs.writeText(file, deviceText({ ...d, alive: now }));
}

/** 다른 기기들 { file, name, kind, alive, lastSync, lines } */
export function devices() {
  let list = [];
  try {
    list = fs.list(DEVICES_DIR) ?? [];
  } catch {}
  return list
    .filter((e) => !e.dir && e.name.endsWith('.md'))
    .map((e) => ({ file: `${DEVICES_DIR}/${e.name}`, ...parseDevice(fs.readText(`${DEVICES_DIR}/${e.name}`)) }))
    .filter((d) => d.name);
}

/** AI 받은함 시트를 이 휴대폰이 처리할 차례인가 */
export const inboxTurn = () => inboxLeader(devices(), { file: me().file, kind: 'phone' }, Date.now());
/** 이 휴대폰의 파일 */
export const myFile = () => me().file;
