// 미리보기용 window.MemoKingNative — 앱(Bridge.kt) 대신 dev/server.mjs 에 물어본다.
// 바로 답하는 함수는 동기 XHR(앱의 JavascriptInterface 처럼 바로 답이 와야 하므로), 오래 걸리는 일은 fetch.
(() => {
  const syncCall = (method, args) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/native/sync', false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({ method, args }));
    return xhr.responseText;
  };
  const methods = [
    'info', 'useInternalVault', 'scan', 'list', 'stat', 'readText', 'writeText', 'writeBase64', 'mkdirs', 'move', 'remove',
    'commitTemp', 'readTempText', 'dropTemp', 'copyText', 'setChrome', 'setHandwriting', 'showKeyboard', 'takeIntent', 'ready', 'scheduleAlarms', 'wasFired', 'notify',
    'historyAll', 'historySetEnabled', 'historyRemove', 'historyClear', 'historyBlock', 'historyUnblock',
    'driveStatus', 'driveSetClient', 'driveDisconnect', 'driveCancelLogin', 'driveSyncSoon',
    'recordStatus', 'recordPause', 'recordResume', 'recordTakeDone', 'recordAck', 'sttStatus',
  ];
  const native = {};
  for (const m of methods) native[m] = (...args) => syncCall(m, args);
  native.call = (id, method, args) => {
    fetch('/native/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: JSON.parse(args || '{}') }) })
      .then((r) => r.text())
      .then((json) => window.__mk?.resolve(id, json));
  };
  window.MemoKingNative = native;
})();
