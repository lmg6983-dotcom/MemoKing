// app/vendor/mathjs.js 로 묶일 계산 기능 (매직키 계산기, npm run vendor)
import { create, all } from 'mathjs';

const math = create(all);
const evaluate = math.evaluate;
const parse = math.parse;
// math.js 보안 안내대로: 식 안에서 새 함수 · 단위를 만들거나 식을 다시 풀지 못하게
const blocked = (name) => () => {
  throw new Error(`${name} is disabled`);
};
math.import(Object.fromEntries(['import', 'createUnit', 'reviver', 'evaluate', 'parse', 'simplify', 'derivative', 'resolve', 'compile'].map((n) => [n, blocked(n)])), { override: true });

export { evaluate, parse };
export const format = math.format;
export const isUnit = math.isUnit;
