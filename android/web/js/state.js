// 화면들이 함께 쓰는 것 — app.js 가 채운다 (목록·메모 화면이 서로를 직접 가져오지 않도록)
export const app = {
  /** @type {import('./vault.js').Vault | null} */
  vault: null,
  /** @type {import('./web-fetch.js').LinkPreviews | null} */
  previews: null,
  /** reminder-panel.js · list-reminders.js 가 쓰는 데스크탑 모양의 API */
  api: null,
  openMemo: async (_id, _options) => {},
  newMemo: async (_options) => {},
  showList: () => {},
  memoMenu: (_id) => {},
  setReminders: (_id, _list) => null,
};

export const COLOR_NAMES = { yellow: '노랑', green: '초록', pink: '분홍', purple: '보라', blue: '파랑', gray: '회색', charcoal: '검정' };

export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
