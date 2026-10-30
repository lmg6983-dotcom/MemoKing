import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionsFor } from '../app/js/magic-actions.js';

test('magic-actions: 복사 액션 id는 모두 copy로 시작하며, 비복사 액션은 copy로 시작하지 않는다', () => {
  // 1. 메모 복사 액션 (내용 복사)
  const noteActs = actionsFor({ kind: 'note', canAppend: true });
  assert.ok(noteActs.some((a) => a.id === 'copyText' && a.id.startsWith('copy')));

  // 2. 파일 복사 액션 (파일 복사, 경로 복사)
  const fileActs = actionsFor({ kind: 'file', path: 'C:\\test.txt' });
  assert.ok(fileActs.some((a) => a.id === 'copyFile' && a.id.startsWith('copy')));
  assert.ok(fileActs.some((a) => a.id === 'copyPath' && a.id.startsWith('copy')));

  // 3. 폴더 복사 액션 (폴더 복사, 경로 복사)
  const folderActs = actionsFor({ kind: 'folder', path: 'C:\\test' });
  assert.ok(folderActs.some((a) => a.id === 'copyFile' && a.id.startsWith('copy')));
  assert.ok(folderActs.some((a) => a.id === 'copyPath' && a.id.startsWith('copy')));

  // 4. 앱 복사 액션 (경로 복사)
  const appActs = actionsFor({ kind: 'app', path: 'C:\\test.lnk' });
  assert.ok(appActs.some((a) => a.id === 'copyPath' && a.id.startsWith('copy')));

  // 5. 계산기 / 날짜 복사 액션 (결과 복사, 식까지 복사, 등)
  const calcActs = actionsFor({ kind: 'calc' });
  assert.ok(calcActs.every((a) => a.id.startsWith('copy')));
  const dateActs = actionsFor({ kind: 'date', plain: '2026-10-30' });
  assert.ok(dateActs.every((a) => a.id.startsWith('copy')));

  // 6. OPMS 복사 액션 (관리번호 복사, 출원번호 복사)
  const opmsActs = actionsFor({ kind: 'opms' });
  assert.ok(opmsActs.some((a) => a.id === 'copyOur' && a.id.startsWith('copy')));
  assert.ok(opmsActs.some((a) => a.id === 'copyApp' && a.id.startsWith('copy')));

  // 7. 비복사 액션들은 copy로 시작하지 않음
  const nonCopyIds = ['open', 'save', 'saveOpen', 'reveal', 'append', 'ask', 'wrapper', 'more'];
  for (const id of nonCopyIds) {
    assert.equal(id.startsWith('copy'), false, `${id} should not start with copy`);
  }
});

