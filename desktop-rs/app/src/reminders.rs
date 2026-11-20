// 일정 · 알림 채널과 알림 실행기, 다른 캘린더 구독. Electron 의 ipc-handlers.js(예약 알림 · 다른 캘린더) · main.js(fireReminder) · alarms.js · calendar-feeds.js 자리.
use crate::state::state;
use memoking_core::calendar_feeds::{self as feeds, Reply};
use memoking_core::reminders::{self as rem, Alert};
use memoking_core::vault::Vault;
use memoking_core::{body, js, time};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub(crate) const SAVED_ELSEWHERE: &str = "그사이 이 메모가 다른 기기에서 바뀌어 저장하지 못했어요. 다시 해 주세요";
pub(crate) const MEMO_PICK_AGAIN: &str = "메모를 찾지 못했어요. 목록에서 다시 골라 주세요";

/// 메모 폴더를 쓰는 일 (열린 폴더가 없으면 None)
fn vault<T>(app: &AppHandle, f: impl FnOnce(&mut Vault) -> T) -> Option<T> {
    state(app).vault.lock().unwrap().as_mut().map(f)
}

pub(crate) fn send_to_note(app: &AppHandle, id: &str, event: &str, payload: Value) {
    if let Some(label) = state(app).note_labels.lock().unwrap().get(id) {
        let _ = app.emit_to(label.as_str(), event, [payload]);
    }
}

/// 알림을 바꿨다: 열린 메모 창 · 목록(일정 탭 · 카드 숫자)에 알리고 바로 한 번 살핀다
pub(crate) fn changed(app: &AppHandle, id: &str, saved: Vec<Value>) {
    send_to_note(app, id, "memo:reminders", saved.into());
    crate::memos::push_list(app);
    let _ = app.emit_to("list", "reminders:changed", [Value::Null; 0]);
    tick(app);
}

/// 일정 · 알림 · 다른 캘린더 채널 — 이 파일이 맡지 않는 채널이면 None
pub fn handle(app: &AppHandle, _label: &str, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    Some(match channel {
        "reminders:set" => set_reminders(app, arg(0).as_str().unwrap_or_default(), arg(1)),
        "reminders:all" => Ok(vault(app, |v| json!(v.all_reminders())).unwrap_or_else(|| json!([]))),
        "reminders:add" => add_reminder(app, arg(0), arg(1), arg(2), arg(3)),
        // 매직키 일정 추가: 기다리는 글을 꺼내 가고(목록 창), 만든 뒤 Windows 알림 (memoId | null, 제목, 안내)
        "reminders:take-magic" => Ok(json!(std::mem::take(&mut *state(app).magic_schedules.lock().unwrap()))),
        "reminders:magic-done" => {
            let (id, title, label) = (arg(0).as_str().unwrap_or_default(), js::string(arg(1)), js::string(arg(2)));
            toast(app, id, if id.is_empty() { "일정을 만들지 못했어요" } else { "일정을 만들었어요" }, &title, &label, None);
            Ok(Value::Null)
        }
        "calendars:feeds" => Ok(json!(feed_list(app))),
        "calendars:set-feeds" => Ok(json!(save_feeds(app, arg(0)))),
        "calendars:fetch" => Ok(fetch_feed(app, &if arg(0).is_null() { String::new() } else { js::string(arg(0)) }, arg(1) == true)),
        _ => return None,
    })
}

fn set_reminders(app: &AppHandle, id: &str, list: &Value) -> Result<Value, String> {
    let Some(list) = list.as_array() else { return Ok(Value::Null) };
    let now = time::now_iso();
    let reminders = list.iter().filter_map(|r| rem::normalize_reminder(r, &now)).collect();
    let Some(saved) = vault(app, |v| v.set_reminders(id, reminders)) else { return Ok(Value::Null) };
    let saved = saved.map_err(|e| e.to_string())?.ok_or(SAVED_ELSEWHERE)?;
    changed(app, id, saved.clone());
    Ok(saved.into())
}

// body: 새 메모를 만들 때 쓸 본문 (다른 캘린더 일정 가져오기 — 달력 그림 · 장소 · 설명). 없으면 "# 일정 이름" 만
fn add_reminder(app: &AppHandle, id: &Value, reminder: &Value, new_title: &Value, body: &Value) -> Result<Value, String> {
    let Some(r) = rem::normalize_reminder(reminder, &time::now_iso()) else { return Ok(Value::Null) };
    let done = vault(app, |v| -> Result<(String, Vec<Value>), String> {
        let memo_id = match id.as_str().filter(|s| !s.is_empty()) {
            Some(id) => Some(id.to_string()),
            None => {
                let title = if new_title.is_null() { String::new() } else { js::string(new_title) };
                let title = js::slice16(&title.split(js::is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "), 80);
                let text = match body.as_str() {
                    Some(b) if js::re(r"^# \S").is_match(b).unwrap_or(false) => js::slice16(b, 20000),
                    _ => format!("# {}\n", if title.is_empty() { "새 일정" } else { &title }),
                };
                v.import(&text, None).map_err(|e| e.to_string())?
            }
        };
        let Some((memo_id, mut list)) = memo_id.and_then(|m| Some((m.clone(), v.entry(&m)?.meta.reminders.clone()))) else { return Err(MEMO_PICK_AGAIN.into()) };
        list.push(r);
        let saved = v.set_reminders(&memo_id, list).map_err(|e| e.to_string())?.ok_or(SAVED_ELSEWHERE)?;
        Ok((memo_id, saved))
    });
    let Some(done) = done else { return Ok(Value::Null) };
    let (memo_id, saved) = done?;
    changed(app, &memo_id, saved);
    Ok(memo_id.into())
}

// ---------- 알림 실행기 (alarms.js) ----------

/// 켤 때 알림을 울리고, 15초마다 울릴 때가 된 알림을 울린다
pub fn start(app: &AppHandle) {
    run(app, |r, now| rem::due_at_startup(r, now).then_some(None));
    let app = app.clone();
    std::thread::spawn(move || loop {
        tick(&app);
        std::thread::sleep(Duration::from_secs(15));
    });
}

/// 날짜 · 시간 · 반복 · 타이머
fn tick(app: &AppHandle) {
    run(app, |r, now| rem::due_occurrence(r, now).map(Some));
}

/// pick: 울릴 것이면 Some(회차와 놓쳤나 — None 은 켤 때 알림)
fn run(app: &AppHandle, pick: impl Fn(&Value, chrono::DateTime<chrono::Local>) -> Option<Option<(Alert, bool)>>) {
    // 실행기와 알림을 바꾼 채널이 함께 돌면 같은 알림을 두 번 울릴 수 있다 — 한 번에 하나씩
    static RUNNING: Mutex<()> = Mutex::new(());
    let _one = RUNNING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let now = chrono::Local::now();
    let Some(all) = vault(app, |v| v.all_reminders()) else { return };
    let mut rang = false;
    for item in all {
        let (id, r) = (item["memoId"].as_str().unwrap_or_default(), &item["reminder"]);
        if pick(r, now).is_none() {
            continue;
        }
        // 울리기 "전에" 먼저 울림 표시(last)를 파일에 적는다 — 적지 못했으면(그사이 파일이 바뀜) 이번엔 울리지 않는다 (두 번 울리지 않게).
        //   목록을 읽은 뒤 채널이 알림을 옮기거나 끄거나 지웠을 수 있다 — 지금 알림으로 다시 고르고 적는다 (옛 것으로 되돌리지 않게)
        let marked = vault(app, |v| {
            let now_list = &v.entry(id)?.meta.reminders;
            let cur = now_list.iter().find(|x| x["id"] == r["id"])?.clone();
            let due = pick(&cur, now)?;
            let list = now_list.iter().map(|x| if x["id"] == cur["id"] { rem::mark_fired(&cur, now) } else { x.clone() }).collect();
            v.set_reminders(id, list).map_err(|e| elog!("울림 표시를 적지 못했습니다: {e}")).ok().flatten()?; // 이 메모만 건너뛰고 다른 알림은 계속
            Some((cur, due))
        })
        .flatten();
        if let Some((cur, due)) = marked {
            fire(app, id, &cur, due, now);
            rang = true;
        }
    }
    if rang {
        crate::memos::push_list(app);
        let _ = app.emit_to("list", "reminders:changed", [Value::Null; 0]);
    }
}

// shortcut: 알림 보관함(history) 기록과 퇴근 뒤 Work 알림 조용히 두기(quietAlarm)는 없다 — 보관함 없이 조용히 두면 알림을 잃으니 늘 울린다, 보관함을 옮길 때 같이
fn fire(app: &AppHandle, id: &str, r: &Value, due: Option<(Alert, bool)>, now: chrono::DateTime<chrono::Local>) {
    let Some(memo) = vault(app, |v| v.get(id)).flatten() else { return };
    let memo_title = memo["title"].as_str().unwrap_or_default();
    let (title, label, full) = rem::alarm_text(r, memo_title, due.as_ref(), now);
    let alarm = json!({ "reminderId": r["id"], "label": full, "missed": due.is_some_and(|d| d.1) });
    let open = state(app).note_labels.lock().unwrap().contains_key(id);
    if r["action"] == "open" && open {
        send_to_note(app, id, "memo:alarm", alarm);
        let _ = crate::memos::open_note(app, id); // 앞으로
        return;
    }
    if r["action"] == "open" {
        state(app).alarms.lock().unwrap().insert(id.into(), alarm);
        if crate::memos::open_note(app, id) == Ok(true) {
            return;
        }
        state(app).alarms.lock().unwrap().remove(id); // 창을 열 수 없으면 알림 창으로라도
    }
    let preview = if memo["locked"] == true { String::new() } else { body::extract_preview(memo["body"].as_str().unwrap_or_default(), 120) };
    toast(app, id, &title, &label, &preview, None);
}

/// Windows 알림 창 — 누르면 그 메모를 연다 (notice: AI 가 한 일이면 열린 메모 창 아래 막대에도 — ai:notice)
#[cfg(windows)]
pub(crate) fn toast(app: &AppHandle, id: &str, title: &str, label: &str, preview: &str, notice: Option<Value>) {
    use tauri_winrt_notification::Toast;
    // 설치판은 설치기가 이 이름(identifier)으로 바로가기를 만든다 — 개발 중에는 Windows 가 모르는 이름이라 PowerShell 이름으로
    let app_id = if cfg!(debug_assertions) { Toast::POWERSHELL_APP_ID.to_string() } else { app.config().identifier.clone() };
    let (app, id) = (app.clone(), id.to_string());
    let shown = Toast::new(&app_id)
        .title(title)
        .text1(label)
        .text2(preview)
        .on_activated(move |_| {
            // 메모가 없는 알림(매직키 일정을 못 만듦)은 일정 탭으로
            if id.is_empty() {
                crate::os::show_list_tab(&app, "reminders");
                return Ok(());
            }
            let _ = crate::memos::open_note(&app, &id);
            if let Some(n) = &notice {
                send_to_note(&app, &id, "ai:notice", n.clone());
            }
            Ok(())
        })
        .show();
    if let Err(err) = shown {
        elog!("알림을 울리지 못했습니다: {err}");
    }
}

// shortcut: 메모킹은 Windows 판만 내므로 다른 OS 는 알림 창 없이 적기만 — 다른 OS 판을 낼 때 그 OS 알림으로
#[cfg(not(windows))]
pub(crate) fn toast(_app: &AppHandle, _id: &str, title: &str, label: &str, preview: &str, _notice: Option<Value>) {
    elog!("[알림] {title} · {label} · {preview}");
}

// ---------- 다른 캘린더 구독 (.ics 주소 · CalDAV 계정 — 이 PC 설정에만) ----------
//   받은 글은 설정 폴더의 calendars\<id>.ics 에 (첫 줄은 { url, at }) — 인터넷이 없을 때 · 다시 켰을 때 그대로 보이게

fn feed_list(app: &AppHandle) -> Vec<Value> {
    feeds::normalize_feeds(&state(app).setting("calendars"))
}

fn cache_file(app: &AppHandle, id: &str) -> std::path::PathBuf {
    state(app).settings_dir.join("calendars").join(format!("{id}.ics"))
}

/// 받아 둔 것 (text, at) — 주소가 바뀌었으면 없는 것으로
fn cached(app: &AppHandle, feed: &Value) -> Option<(String, i64)> {
    let raw = std::fs::read_to_string(cache_file(app, feed["id"].as_str()?)).ok()?;
    let (meta, text) = raw.split_once('\n')?;
    let meta: Value = serde_json::from_str(meta).ok()?;
    (meta["url"] == feed["url"]).then(|| (text.to_string(), meta["at"].as_i64().unwrap_or(0)))
}

/// 구독 목록 저장 — 빠졌거나 주소 · 계정이 바뀐 캘린더의 받아 둔 것은 지운다
fn save_feeds(app: &AppHandle, list: &Value) -> Vec<Value> {
    let next = feeds::normalize_feeds(if list.is_array() { list } else { &Value::Null });
    for f in feed_list(app) {
        if !next.iter().any(|n| ["id", "url", "user", "pass"].iter().all(|k| n[k] == f[k])) {
            let _ = std::fs::remove_file(cache_file(app, f["id"].as_str().unwrap_or_default()));
        }
    }
    state(app).set_setting("calendars", json!(next));
    next
}

/// 받기 · 받아 둔 것: 15분 안이면 받아 둔 것, 아니면 새로 받고, 받지 못하면 받아 둔 것 + 오류 → { text, at, error? }
// shortcut: 받는 동안 IPC 스레드 하나를 붙잡는다 (async 명령 안의 동기 HTTP) — 구독이 많아 다른 채널이 느려지면 spawn_blocking 으로
fn fetch_feed(app: &AppHandle, id: &str, force: bool) -> Value {
    let Some(feed) = feed_list(app).into_iter().find(|f| f["id"] == id) else { return json!({ "text": "", "at": 0, "error": "없는 캘린더예요" }) };
    let old = cached(app, &feed);
    let now = || chrono::Local::now().timestamp_millis();
    if let Some((text, at)) = old.as_ref().filter(|(_, at)| !force && now() - at < feeds::FEED_FRESH_MS) {
        return json!({ "text": text, "at": at });
    }
    // 같은 캘린더를 겹쳐 받지 않는다: 하나씩 — 기다린 사이 다른 쪽이 받아 왔으면 그것을
    static INFLIGHT: Mutex<Option<HashMap<String, Arc<Mutex<()>>>>> = Mutex::new(None);
    let gate = INFLIGHT.lock().unwrap().get_or_insert_with(HashMap::new).entry(id.to_string()).or_default().clone();
    let _one = gate.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((text, at)) = cached(app, &feed).filter(|(_, at)| Some(*at) != old.as_ref().map(|o| o.1)) {
        return json!({ "text": text, "at": at });
    }
    match download(&feed) {
        Ok(text) => {
            let at = now();
            // 받는 사이 연결을 끊었거나 주소를 바꿨으면 남기지 않는다 (비공개 캘린더가 남지 않게)
            if feed_list(app).iter().any(|f| f["id"] == feed["id"] && f["url"] == feed["url"] && f["user"] == feed["user"]) {
                let file = cache_file(app, id);
                let _ = std::fs::create_dir_all(file.parent().unwrap());
                let _ = std::fs::write(&file, format!("{}\n{text}", json!({ "url": feed["url"], "at": at }))); // 못 쓰면 다음에 다시 받으면 됨
            }
            json!({ "text": text, "at": at })
        }
        Err(err) => json!({ "text": old.as_ref().map_or("", |o| o.0.as_str()), "at": old.map_or(0, |o| o.1), "error": err }),
    }
}

/// 응답 본문을 5MB 까지만
fn read_limited(res: &mut ureq::http::Response<ureq::Body>) -> Result<String, String> {
    let declared: u64 = res.headers().get("content-length").and_then(|v| v.to_str().ok()?.parse().ok()).unwrap_or(0);
    let mut buf = vec![];
    let limit = feeds::MAX_FEED_BYTES as u64;
    res.body_mut().as_reader().take(limit + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if declared > limit || buf.len() as u64 > limit {
        return Err(feeds::TOO_BIG.into());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn download(feed: &Value) -> Result<String, String> {
    let url = feed["url"].as_str().unwrap_or_default();
    let agent = |redirects| -> ureq::Agent {
        crate::files::web_config()
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .max_redirects(redirects)
            .allow_non_standard_methods(true) // PROPFIND · REPORT
            .build()
            .into()
    };
    if let Some(user) = feed["user"].as_str() {
        // 넘겨 가기는 caldav_ics 가 같은 서버일 때만 (비밀번호가 다른 곳으로 가지 않게)
        let agent = agent(0);
        let mut request = |method: &str, url: &str, headers: &[(&str, &str)], body: &str| -> Result<Reply, String> {
            let mut req = ureq::http::Request::builder().method(method).uri(url);
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            let req = req.body(body.to_string()).map_err(|e| e.to_string())?;
            let mut res = agent.run(req).map_err(|_| "캘린더 서버에 연결하지 못했어요 (인터넷 확인)".to_string())?;
            let location = res.headers().get("location").and_then(|l| l.to_str().ok()).unwrap_or_default().to_string();
            Ok((res.status().as_u16(), location, read_limited(&mut res)?))
        };
        return feeds::caldav_ics(url, user, feed["pass"].as_str().unwrap_or_default(), &mut request);
    }
    let mut res = agent(10).get(url).header("Accept", "text/calendar, */*;q=0.5").call().map_err(|_| "캘린더 주소에 연결하지 못했어요 (인터넷 확인)".to_string())?;
    let status = res.status().as_u16();
    feeds::check_feed_status(status)?; // 본문을 받기 전에
    feeds::feed_response_text(status, read_limited(&mut res)?)
}
