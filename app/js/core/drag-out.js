// 메모킹에서 끌어낸 파일이 메모킹(메모 창 · 목록 창)에 도로 떨어졌는지 — 그러면 취소로 (파일이 하나 더 생기지 않게).
//   WebView2 는 놓은 파일의 경로를 알려 주지 않아, 끌기를 시작할 때 끄는 임시 파일 이름 · 시각을 모든 창이 보는 localStorage 에 적어 둔다
const KEY = 'memoking.dragOut';
const WITHIN_MS = 2 * 60 * 1000; // 끌기를 시작하고 이만큼 안에 놓은 것만 (나중에 같은 이름 파일을 탐색기에서 끌어 온 것은 보통 넣기)

/** 끌기를 시작했다 (copy-content.js dragOutBlock) — name: 끄는 파일 이름 */
export function rememberDragOut(name) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ name, at: Date.now() }));
  } catch {
    // 못 적으면 도로 놓았을 때 파일이 하나 더 생길 뿐
  }
}

/** 놓은 파일 중에 방금 메모킹이 끌어낸 것이 있는가 (한 번 알아보면 지운다) */
export function isOwnDragOut(dataTransfer, now = Date.now()) {
  if (!dataTransfer?.files?.length) return false;
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return false;
  }
  if (!last?.name || now - last.at > WITHIN_MS) return false;
  const own = [...dataTransfer.files].some((file) => file.name === last.name);
  if (own) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // 그대로
    }
  }
  return own;
}
