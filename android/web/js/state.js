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
  deleteMemo: async (_id) => {},
  filterByTag: (_name) => {},
  deliverRecording: async (_result) => {},
  closeFabMenu: () => false,
  sttTerms: () => [],
};

