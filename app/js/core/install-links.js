// 메모킹 설치 파일의 늘 같은 주소 (이 저장소의 Release — 새 버전이 나와도 바뀌지 않는다)
const RELEASES = 'https://github.com/lmg6983-dotcom/MemoKing/releases';

/** Windows PC 설치 파일 (release.yml 이 Release 마다 같은 이름으로도 올린다) */
export const WINDOWS_SETUP = `${RELEASES}/latest/download/MemoKing-Setup.exe`;
/** 안드로이드 설치 파일 (android.yml 이 "android" Release 에 늘 최신으로) */
export const ANDROID_APK = `${RELEASES}/download/android/MemoKing-android.apk`;

/** 다른 사람에게 보낼 글 (메신저 · 메일) */
export const installShareText = () => `메모킹 설치 링크\nWindows PC: ${WINDOWS_SETUP}\n안드로이드 휴대폰: ${ANDROID_APK}`;
