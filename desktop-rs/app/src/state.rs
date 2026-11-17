// 앱 상태 — 설정(settings.json)과 열린 메모 폴더. Electron 의 desktop/utils.js settings · main.js openVault 자리.
use memoking_core::vault::{write_atomic, Vault};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub fn state(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

pub struct State {
    pub settings_dir: PathBuf,
    pub settings: Mutex<Map<String, Value>>,
    /// 설정 파일이 깨져 새로 시작했다 (목록이 알린다)
    pub settings_reset: bool,
    pub vault: Mutex<Option<Vault>>,
    pub vault_error: Mutex<Option<String>>,
    /// 켤 때 찾지 못한 쓰던 메모 폴더 (꺼 둔 사이 옮김 · 외장 드라이브를 뺌) — 빈 폴더를 새로 만들지 않고 기다린다
    pub vault_missing: Mutex<Option<String>>,
    /// 메모 id → 메모 창 이름 (창 이름에는 영문 · 숫자만 쓸 수 있어 id 를 그대로 못 쓴다)
    pub note_labels: Mutex<HashMap<String, String>>,
    /// 이어 쓰기: 이미 알린 "id@updated" 와 마지막으로 알린 것 ({ id, title, from, at })
    pub handoff: Mutex<(std::collections::HashSet<String>, Option<Value>)>,
    /// 메모 창이 열리며 넣을 문서 첨부 (memo:import → memo:get insert)
    pub inserts: Mutex<HashMap<String, Value>>,
    /// 메모 창이 열리면 할 일 (목록 카드 메뉴의 잠그기 · 버전, 찾던 말) — memo:get command
    pub commands: Mutex<HashMap<String, Value>>,
    /// 닫힌 메모를 여는 알림: 창이 열리면 띠로 (memo:get alarm)
    pub alarms: Mutex<HashMap<String, Value>>,
}

/// 설정 폴더: Electron 과 같은 %APPDATA%\MemoKing (MagicKey · MagicSystem 이 여기서 읽는다).
///   --profile=이름 이면 MemoKing-이름 (옮기는 동안 Electron 판과 따로 시험), --smoke 면 임시 폴더
fn settings_dir(app: &AppHandle) -> PathBuf {
    let arg = |p: &str| std::env::args().find_map(|a| a.strip_prefix(p).map(str::to_string));
    if crate::ipc::smoke() {
        return std::env::temp_dir().join(format!("memoking-smoke-{}", std::process::id()));
    }
    let base = app.path().config_dir().unwrap_or_else(|_| std::env::temp_dir());
    match arg("--profile=") {
        Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => base.join(format!("MemoKing-{p}")),
        _ => base.join("MemoKing"),
    }
}

impl State {
    pub fn load(app: &AppHandle) -> State {
        let dir = settings_dir(app);
        let file = dir.join("settings.json");
        let mut reset = false;
        let mut settings = Map::new();
        if let Ok(text) = std::fs::read_to_string(&file) {
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(m)) => {
                    let first = !m.contains_key("tutorialDone");
                    settings = m;
                    if first {
                        settings.insert("tutorialDone".into(), true.into());
                    }
                }
                _ => {
                    // 깨진 설정은 덮어쓰기 전에 따로 남긴다 (메모 폴더 위치 · Drive 연결을 되살릴 수 있게)
                    reset = true;
                    let _ = std::fs::copy(&file, dir.join(format!("settings.json.broken-{}", chrono_ms())));
                    settings.insert("tutorialDone".into(), true.into());
                }
            }
        }
        State {
            settings_dir: dir,
            settings: Mutex::new(settings),
            settings_reset: reset,
            vault: Mutex::new(None),
            vault_error: Mutex::new(None),
            vault_missing: Mutex::new(None),
            note_labels: Mutex::new(HashMap::new()),
            handoff: Default::default(),
            inserts: Default::default(),
            commands: Default::default(),
            alarms: Default::default(),
        }
    }

    /// 설정 쓰기 (모르는 항목도 그대로 — Electron 판 · MagicKey 가 쓰는 것)
    pub fn save_settings(&self) {
        let text = serde_json::to_string_pretty(&*self.settings.lock().unwrap()).unwrap();
        let _ = std::fs::create_dir_all(&self.settings_dir);
        if let Err(err) = write_atomic(&self.settings_dir.join("settings.json"), text.as_bytes()) {
            eprintln!("설정 저장 실패: {err}");
        }
    }

    pub fn setting(&self, key: &str) -> Value {
        self.settings.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn set_setting(&self, key: &str, value: Value) {
        self.settings.lock().unwrap().insert(key.into(), value);
        self.save_settings();
    }

    /// 처음 메모 폴더: 문서\메모킹
    pub fn suggested_vault(app: &AppHandle) -> PathBuf {
        if crate::ipc::smoke() {
            return std::env::temp_dir().join(format!("memoking-smoke-{}", std::process::id())).join("vault");
        }
        app.path().document_dir().unwrap_or_else(|_| std::env::temp_dir()).join("메모킹")
    }

    /// 메모 폴더 열기 (못 열면 vault_error 에 까닭) — 목록 창에 vault:opened
    pub fn open_vault(&self, app: &AppHandle, dir: PathBuf) {
        let mut v = Vault::new(&dir, "pc");
        // 새 메모는 지금 고른 Work / Life 로 — 나눠 쓰지 않으면 Life (Electron viewMode)
        let mode = if self.setting("workLife") == true && self.setting("mode") == "work" { "work" } else { "life" };
        v.default_mode = mode.into();
        match v.open() {
            Ok(()) => {
                crate::index::opened(&dir);
                *self.vault.lock().unwrap() = Some(v);
                *self.vault_error.lock().unwrap() = None;
                *self.vault_missing.lock().unwrap() = None;
                self.set_setting("vaultPath", dir.to_string_lossy().into_owned().into());
            }
            Err(err) => {
                *self.vault.lock().unwrap() = None;
                *self.vault_error.lock().unwrap() = Some(format!("메모 폴더를 열지 못했어요: {err}"));
            }
        }
        let _ = app.emit_to("list", "vault:opened", [self.vault_info(app)]);
    }

    /// 화면이 묻는 메모 폴더 상태 (vaultInfo)
    pub fn vault_info(&self, app: &AppHandle) -> Value {
        let root = self.vault.lock().unwrap().as_ref().map(|v| v.root.to_string_lossy().into_owned());
        json!({
            "vaultPath": root,
            "vaultError": *self.vault_error.lock().unwrap(),
            "missingPath": *self.vault_missing.lock().unwrap(),
            "suggestedPath": State::suggested_vault(app).to_string_lossy(),
            "version": app.package_info().version.to_string(),
            "sandbox": false,
            "settingsReset": self.settings_reset,
        })
    }
}

fn chrono_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis())
}
