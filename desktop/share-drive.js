// Google Drive 로 공유: 내 드라이브의 "메모킹 공유" 폴더에 올리고, 링크가 있는 사람은 볼 수 있는 링크를 만든다
//   (메모킹이 만든 파일만 다루는 drive.file 권한으로 충분) — 폴더 id 는 설정에 기억.
//   기억한 폴더가 지워졌거나 휴지통에 있으면: 같은 이름의 (휴지통 아닌) 폴더를 찾아 쓰고, 없으면 새로 만든다
export const SHARE_FOLDER = '메모킹 공유';

async function shareFolder(api, store) {
  if (store.folderId && (await api.alive(store.folderId))) return store.folderId;
  const found = await api.findFolder(SHARE_FOLDER);
  const id = found?.id ?? (await api.createFolder('root', SHARE_FOLDER)).id;
  store.saveFolderId(id);
  return id;
}

/**
 * @param {import('./drive/drive-api.js').DriveApi} api
 * @param {{ folderId?: string, saveFolderId: (id: string) => void }} store
 * @returns {Promise<string>} 링크
 */
export async function driveShareLink(api, store, file, name) {
  const up = await api.upload(await shareFolder(api, store), name, null, file);
  return api.shareLink(up.id);
}
