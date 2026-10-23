// 다른 앱 메모 가져오기 (PC · 휴대폰 함께) — Google 파일 고르기 화면에서 고른 .md 를 메모 폴더로
//   기본 권한(drive.file)은 메모킹이 만들었거나 사용자가 고른 파일만 연다 (Drive 전체 권한 · '확인되지 않은 앱' 안내 없이)
//   - 메모 폴더 안에서 고른 파일: 이제 메모킹이 열 수 있어 다음 동기화로 그대로 들어온다
//   - 다른 곳에서 고른 파일: 메모 폴더로 사본을 만든다 (사본은 메모킹이 만든 파일이라 계속 동기화된다)
//   - 고른 폴더: 안의 메모가 보이면 함께, 보이지 않으면(drive.file 은 대개 폴더 안까지 열지 않는다) 파일을 고르게 안내

export const isMemoFile = (f) => !f.folder && /\.md$/i.test(f.name ?? '');

/** 메모 폴더에 이미 있는 이름이면 "이름 (2).md" 처럼 (Drive 는 같은 이름을 여럿 두지만 이 PC · 휴대폰의 파일은 이름 하나에 하나) */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  const base = name.replace(/\.md$/i, '');
  for (let k = 2; ; k++) {
    const n = `${base} (${k}).md`;
    if (!taken.has(n)) return n;
  }
}

/**
 * @param {string[]} ids 고른 파일 · 폴더
 * @param {string} folderId 메모 폴더
 * @param {{ meta: (id: string) => Promise<{ id: string, name: string, folder: boolean, parents: string[] }>,
 *           children: (id: string) => Promise<{ id: string, name: string, folder: boolean }[]>,
 *           copy: (id: string, parent: string, name: string) => Promise<unknown> }} api
 * @param {string[]} before 고르기 전에 메모 폴더에서 보이던 파일 id (메모 폴더 자체를 골랐을 때 새로 열린 것을 센다)
 * @returns {Promise<{ kept: number, copied: number, skipped: number, closedFolders: number }>}
 */
export async function importPicked(ids, folderId, api, before = []) {
  const out = { kept: 0, copied: 0, skipped: 0, closedFolders: 0 };
  const here = await api.children(folderId);
  const taken = new Set(here.map((f) => f.name));
  const files = [];
  for (const id of new Set(ids)) {
    const m = await api.meta(id);
    if (!m.folder) {
      files.push(m);
      continue;
    }
    if (m.id === folderId) {
      // 메모 폴더 자체를 골랐다: 안의 메모가 새로 열렸으면 그대로 들어온다
      const seenBefore = new Set(before);
      const opened = here.filter((f) => isMemoFile(f) && !seenBefore.has(f.id));
      if (!opened.length) out.closedFolders++;
      files.push(...opened.map((f) => ({ ...f, parents: [folderId] })));
      continue;
    }
    const inside = (await api.children(m.id)).filter(isMemoFile);
    if (!inside.length) out.closedFolders++;
    files.push(...inside.map((f) => ({ ...f, parents: [m.id] })));
  }
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (!isMemoFile(f)) out.skipped++;
    else if (f.parents?.includes(folderId)) out.kept++;
    else {
      const name = freeName(f.name, taken);
      taken.add(name);
      await api.copy(f.id, folderId, name);
      out.copied++;
    }
  }
  return out;
}

/** 가져온 뒤 알릴 말 */
export function importMessage({ kept = 0, copied = 0, skipped = 0, closedFolders = 0 } = {}) {
  const n = kept + copied;
  const parts = [];
  if (n) parts.push(`다른 앱 메모 ${n}개를 가져왔어요`);
  if (skipped) parts.push(`메모(.md)가 아닌 파일 ${skipped}개는 건너뛰었어요`);
  if (closedFolders) parts.push(n ? '고른 폴더 안의 메모는 열 수 없었어요. 폴더를 열고 메모 파일을 골라 주세요' : '고른 폴더 안의 메모는 열 수 없었어요. 폴더를 열고 메모 파일을 하나씩 골라 주세요');
  if (!parts.length) return '고른 파일이 없어요';
  return parts.join('. ');
}
