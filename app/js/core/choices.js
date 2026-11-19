// 넣을 때 묻는 것을 "앞으로 이렇게" 로 기억한 고르기 — 이 기기의 localStorage 에만 (rename-content.js 가 쓰고, 설정 화면이 지운다)
export const CHOICE_KEY = 'memoking.choices';
export const loadChoices = () => {
  try {
    return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
};
/** 기억한 고르기가 있나 (설정에서 "다시 묻기" 단추를 보일지) */
export const hasRememberedChoices = () => Object.keys(loadChoices()).length > 0;
export function forgetChoices() {
  try {
    localStorage.removeItem(CHOICE_KEY);
  } catch {
    // 지우지 못해도 이번엔 그대로
  }
}
