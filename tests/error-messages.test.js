// 사용자에게 보이는 오류 문구 규칙: "무슨 일" 뒤에 "다음에 할 일"(다시 · 확인 · 연결 · 골라 · 설치 …)이 붙어 있다
//   이번에 다듬은 문구들을 소스에서 찾아 규칙을 지키는지 본다 (문구를 바꾸다 다음에 할 일이 빠지면 여기서 걸린다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ACTION = /(다시|확인|연결|골라|넣어|설치|허용|풀고|기다|시도|바꿔|써 주세요|해 주세요|눌러|정해|나눠|되살려)/;
const FILES = {
  'desktop/drive/google-auth.js': ['Google 로그인 설정(연결 ID', 'Google 서버에 문제가 있어요'],
  'desktop/drive/drive-api.js': ['Google Drive가 올릴 주소를 주지 않았어요'],
  'desktop/ipc-handlers.js': ['Google Drive 를 쓸 수 없어요', '메모를 찾지 못했어요', '메모 폴더가 아직 없어요', '메모를 만들지 못했어요', '이 파일로는 메모를 만들 수 없어요', '파일을 찾지 못했어요', '파일이 너무 커요'],
  'desktop/utils.js': ['그림을 읽지 못했어요', '그림이 아니에요', '50MB보다 커서'],
  'desktop/stt/stt-service.js': ['받지 못했어요 (', '받은 파일이 맞지 않아요'],
  'app/js/copy-content.js': ['그림을 아직 불러오지 못했어요'],
  'app/js/note.js': ['지원하지 않는 그림 형식이에요'],
  'app/js/list.js': ['글 파일이 너무 커요'],
  'app/js/core/memo-lock.js': ['잠금 정보가 망가진 메모예요'],
  'android/web/js/note-view.js': ['지원하지 않는 그림 형식이에요', '잠긴 메모의 사본을 만들 수 없어요'],
  'android/web/js/app.js': ['메모를 찾지 못했어요'],
  'android/app/src/main/java/com/memoking/app/RecorderService.kt': ['마이크 권한이 없어요', '마이크를 열지 못했어요', '이미 녹음하고 있어요'],
  'android/app/src/main/java/com/memoking/app/AppUpdate.kt': ['업데이트 정보를 받지 못했어요', '새 버전을 받지 못했어요'],
};

test('사용자에게 보이는 오류 문구에는 다음에 할 일이 붙어 있다', () => {
  const bad = [];
  for (const [file, starts] of Object.entries(FILES)) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const start of starts) {
      // 문구가 있는 줄들 중 하나라도 그 줄 안에서 다음에 할 일을 말하면 된다
      const lines = src.split('\n').filter((l) => l.includes(start));
      if (!lines.length) bad.push(`${file}: "${start}" 문구가 없어졌어요 (규칙 목록도 함께 고치세요)`);
      else if (!lines.every((l) => ACTION.test(l.slice(l.indexOf(start))))) bad.push(`${file}: "${start}…" 뒤에 다음에 할 일이 없어요`);
    }
  }
  assert.deepEqual(bad, []);
});
