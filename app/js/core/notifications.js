// Windows 알림 보관함 — 알림 DB(wpndatabase.db) 의 값 해석 (순수 함수, 단위 테스트 대상)
import { decodeEntities, XML_ENTITIES } from './entities.js';

// Windows FILETIME(1601년부터 100나노초 단위, BigInt) → 밀리초 시각
export function fileTimeToMs(ticks) {
  return Number(BigInt(ticks) / 10000n) - 11644473600000;
}

const decodeXml = (text) => decodeEntities(text, XML_ENTITIES);

/**
 * 토스트 알림 XML → { title, body, image }
 *   <toast><visual><binding template="ToastGeneric"><text>제목</text><text>내용</text>…<image src="…"/></binding></visual></toast>
 */
export function parseToastXml(xml) {
  const source = String(xml ?? '');
  if (!/<toast[\s>]/i.test(source)) return null;
  const texts = [...source.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) => decodeXml(m[1].replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean);
  const images = [...source.matchAll(/<image\b([^>]*)>/gi)].map((m) => {
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(m[1])?.[1];
    const placement = /\bplacement\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? '';
    return src ? { src: decodeXml(src), placement } : null;
  }).filter(Boolean);
  const image = (images.find((i) => i.placement === 'appLogoOverride') ?? images[0])?.src ?? null;
  if (!texts.length) return null;
  return { title: texts[0], body: texts.slice(1).join('\n'), image };
}

// 앱 이름을 모를 때: "Microsoft.Teams_8wekyb3d8bbwe!MSTeams" → "MSTeams", "com.daou.msn" → "msn"
export function fallbackAppName(appId) {
  const id = String(appId ?? '');
  const afterBang = id.includes('!') ? id.slice(id.lastIndexOf('!') + 1) : id;
  const tail = afterBang.split(/[\\/]/).pop();
  const name = tail.includes('.') && !/\.exe$/i.test(tail) ? tail.split('.').pop() : tail.replace(/\.exe$/i, '');
  return name || id || '알 수 없는 앱';
}

// 검색: 앱 이름·제목·내용, 공백으로 나눈 모든 낱말 포함
export function matchesQuery(entry, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${entry.app} ${entry.title} ${entry.body}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
