// 휴대폰(android/web)과 PC(app)가 함께 쓰는 코드에서 없는 이름을 가져오면 휴대폰은 흰 화면이 된다 (0.54.2) —
// 모든 상대 경로 import { 이름 } 이 그 파일에 실제로 export 되어 있는지 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const files = ['app/js', 'android/web/js'].flatMap((d) => fs.readdirSync(d, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function exportsOf(file) {
  const src = strip(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) if (part.trim()) names.add(part.trim().split(/\s+as\s+/).pop());
  if (/export\s+default\b/.test(src)) names.add('default');
  return { names, star: /export\s*\*\s*from/.test(src) };
}

test('상대 경로로 가져오는 이름은 모두 그 파일에 있다', () => {
  const missing = [];
  for (const file of files) {
    for (const m of strip(fs.readFileSync(file, 'utf8')).matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      // 휴대폰에서는 android/web 이 app/ 옆에 놓인다 (android/app/build.gradle.kts) — ../../app 은 저장소의 app/
      const target = path.join(path.dirname(file), m[2]).replace(/^android[\\/]app[\\/]/, `app${path.sep}`);
      if (!fs.existsSync(target)) {
        missing.push(`${file}: ${m[2]} 파일 없음`);
        continue;
      }
      const { names, star } = exportsOf(target);
      if (star) continue;
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !names.has(name)) missing.push(`${file}: ${name} ← ${m[2]}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
