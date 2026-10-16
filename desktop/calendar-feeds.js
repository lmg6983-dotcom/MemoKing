// 일정 탭이 구독하는 다른 캘린더(.ics 주소, 예: Google 캘린더 "iCal 형식의 비공개 주소") 받기 — PC 메인 프로세스
//   화면(목록 창)에서 바로 받으면 CORS 에 막히므로 메인이 받는다. 주소는 비밀(누구나 그 캘린더를 볼 수 있음)이라
//   메모 폴더(동기화 · AI 인덱스)가 아니라 이 PC 설정(%APPDATA%\MemoKing)에만 둔다.
//   받은 글은 %APPDATA%\MemoKing\calendars\<id>.ics 에 두어 인터넷이 없을 때·다시 켰을 때 그대로 보인다.
//   받는 규칙(15분 · 겹쳐 받지 않기 · 끊은 구독은 남기지 않기)은 휴대폰과 같은 core/calendar-feed-list.js 의 FeedStore
import fs from 'node:fs';
import path from 'node:path';
import { FeedStore, checkFeedStatus, feedResponseText, MAX_FEED_BYTES, FEED_FRESH_MS } from '../app/js/core/calendar-feed-list.js';

export const FRESH_MS = FEED_FRESH_MS;
const TIMEOUT_MS = 20_000;
const TOO_BIG = '캘린더가 너무 커요 (5MB 넘음)';

/** 응답 본문을 limit 바이트까지만 */
async function readLimited(res, limit) {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new Error(TOO_BIG);
  if (!res.body?.getReader) {
    const text = await res.text();
    if (Buffer.byteLength(text) > limit) throw new Error(TOO_BIG);
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new Error(TOO_BIG);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class CalendarFeeds extends FeedStore {
  /**
   * @param {{ dir: string, fetch: typeof fetch, getList: () => any[], setList: (list: any[]) => void, now?: () => number }} options
   */
  constructor({ dir, fetch: fetchImpl, getList, setList, now = Date.now }) {
    const mem = new Map(); // id → { url, text, at }
    const file = (id) => path.join(dir, `${id}.ics`);
    super({
      getList,
      setList,
      now,
      download: async (url) => {
        let res;
        try {
          res = await fetchImpl(url, { headers: { Accept: 'text/calendar, */*;q=0.5' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch {
          throw new Error('캘린더 주소에 연결하지 못했어요 (인터넷 확인)');
        }
        checkFeedStatus(res.status); // 본문을 받기 전에
        return feedResponseText(res.status, await readLimited(res, MAX_FEED_BYTES));
      },
      cache: {
        read: (feed) => {
          if (mem.has(feed.id)) return mem.get(feed.id);
          try {
            const raw = fs.readFileSync(file(feed.id), 'utf8');
            const nl = raw.indexOf('\n');
            const meta = JSON.parse(raw.slice(0, nl));
            const entry = { url: meta.url, text: raw.slice(nl + 1), at: meta.at };
            mem.set(feed.id, entry);
            return entry;
          } catch {
            return null;
          }
        },
        write: (feed, entry) => {
          mem.set(feed.id, entry);
          return fs.promises.mkdir(dir, { recursive: true })
            .then(() => fs.promises.writeFile(file(feed.id), `${JSON.stringify({ url: entry.url, at: entry.at })}\n${entry.text}`))
            .catch(() => {}); // 다음에 다시 받으면 됨
        },
        remove: (id) => {
          mem.delete(id);
          fs.rm(file(id), { force: true }, () => {});
        },
      },
    });
  }
}
