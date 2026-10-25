// 목록 카드의 동영상 첫 장면 (PC 목록 · 휴대폰 목록이 함께 쓴다)
//   카드가 화면에 들어오면 그 동영상을 한 번 열어 1초쯤의 장면을 작은 JPG 로 그리고, 이 기기에 기억한다 (IndexedDB).
//   다음부터는 그림만 띄운다 — 동영상을 카드마다 열지 않게. 메모 파일은 건드리지 않는다.
//   열 수 없는 동영상(코덱 · 깨진 파일)은 칸을 지우고 지금처럼 카드 아래 동영상 아이콘만.
// shortcut: 기억은 첨부 경로로 찾는다 (첨부 파일은 넣을 때마다 새 이름이라). 같은 이름에 다른 영상을 덮어쓰면 옛 장면이 남는다
import { vaultUrl } from './media.js';

const DB = 'memoking-posters';
const STORE = 'posters';
const WIDTH = 480; // 카드에 넉넉한 크기 (한 장 20KB 안팎)
const AT = 1; // 몇 초의 장면 (처음 장면은 검은 화면이 많다)
const WAIT_MS = 10_000;

let dbp = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function stored(key, blob) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, blob ? 'readwrite' : 'readonly');
    const req = blob ? tx.objectStore(STORE).put(blob, key) : tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** 동영상의 한 장면 → JPG Blob (못 그리면 null) */
export function grabFrame(url, { at = AT, width = WIDTH, wait = WAIT_MS } = {}) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous'; // PC: memoking:// 가 다른 출처라 — 허락을 받아야 그린 그림을 꺼낼 수 있다
    let done = false;
    const finish = (blob) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load(); // 열어 둔 파일을 놓는다
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), wait);
    video.addEventListener('error', () => finish(null));
    video.addEventListener('loadeddata', () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = d ? Math.min(at, d / 3) : 0;
    }, { once: true });
    video.addEventListener('seeked', () => {
      if (!video.videoWidth) return finish(null);
      const w = Math.min(width, video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = Math.round((video.videoHeight / video.videoWidth) * w);
      try {
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.8);
      } catch {
        finish(null); // 다른 출처라 꺼낼 수 없음 등
      }
    }, { once: true });
    video.src = url;
  });
}

const urls = new Map(); // 첨부 경로 → 그림 주소 (이 창에서 한 번만 만든다)
let queue = Promise.resolve(); // 동영상은 한 번에 하나씩 연다 (목록에 영상이 많아도 한꺼번에 열지 않게)

/** 첨부 경로의 첫 장면 그림 주소 (기억해 둔 것 → 없으면 그려서 기억) · 못 그리면 null */
export function videoPoster(src) {
  if (!urls.has(src)) {
    urls.set(src, (async () => {
      let blob = await stored(src).catch(() => null);
      if (!blob) {
        const run = queue.then(() => grabFrame(vaultUrl(src)));
        queue = run.catch(() => {});
        blob = await run;
        if (blob) await stored(src, blob).catch(() => {}); // 기억 못 해도 이번엔 보인다
      }
      if (!blob) urls.delete(src); // 다음에 다시 (파일이 아직 동기화 전이었을 수도)
      return blob ? URL.createObjectURL(blob) : null;
    })());
  }
  return urls.get(src);
}

// 카드가 화면 가까이 올 때만 그린다 (스크롤해 내려가야 보이는 수백 장을 미리 열지 않게)
let seen = null;
function watch(box, src) {
  seen ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      const { src: s, img } = e.target.__poster;
      videoPoster(s).then((url) => {
        if (url) img.src = url;
        else e.target.remove(); // 못 그리면 칸을 지운다 (카드 아래 동영상 아이콘은 그대로)
      });
    }
  }, { rootMargin: '300px 0px' });
  box.__poster = { src, img: box.firstChild };
  seen.observe(box);
}

/** 목록 카드에 넣을 동영상 첫 장면 칸 (사진 썸네일과 같은 자리 · 크기, 가운데 ▶) */
export function videoThumb(src) {
  const box = document.createElement('div');
  box.className = 'card-thumb card-video';
  box.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  box.append(img);
  watch(box, src);
  return box;
}
