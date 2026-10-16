// Google Drive 로 공유: 내 드라이브의 "메모킹 공유" 폴더에 올리고, 링크가 있는 사람은 볼 수 있는 링크를 만든다
//   (메모킹이 만든 파일만 다루는 drive.file 권한으로 충분) — 폴더 id 는 설정에 기억, 지워졌으면 다시 만든다
export const SHARE_FOLDER = '메모킹 공유';

/**
 * @param {import('./drive/drive-api.js').DriveApi} api
 * @param {{ folderId?: string, saveFolderId: (id: string) => void }} store
 * @returns {Promise<string>} 링크
 */
export async function driveShareLink(api, store, file, name) {
  let folderId = store.folderId;
  if (!folderId) {
    folderId = (await api.createFolder('root', SHARE_FOLDER)).id;
    store.saveFolderId(folderId);
  }
  let up;
  try {
    up = await api.upload(folderId, name, null, file);
  } catch (err) {
    if (err?.status !== 404) throw err;
    folderId = (await api.createFolder('root', SHARE_FOLDER)).id; // 폴더를 지웠으면 새로
    store.saveFolderId(folderId);
    up = await api.upload(folderId, name, null, file);
  }
  return api.shareLink(up.id);
}
