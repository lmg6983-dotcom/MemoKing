// app/vendor/chrono.js 로 묶일 영어 날짜 해석 (npm run vendor) — 글 속 "tomorrow 5pm" 을 알림 시각으로 (한국어는 core/date-detect.js)
import * as chrono from 'chrono-node/en';
export const casual = chrono.casual;
