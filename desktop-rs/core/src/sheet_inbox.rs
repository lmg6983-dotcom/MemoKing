//! AI 받은함 (_memoking/AI 받은함 Google 시트) — AI(Gemini 등)가 메모를 만들고 고치는 단 하나의 창구.
//!   app/js/core/sheet-inbox.js 와 같은 규칙 (tests/parity.rs sheet_inbox). 시트는 CSV 로 내려받고 CSV 로 덮어쓴다 (drive.file 권한만)
//!   7열: req_id · action(create · append · replace · trash) · memo_id · folder · body · find · status
//!   AI 가 status 를 pending 으로 적으면, 켜져 있는 기기 한 대(devices::inbox_leader)가 처리하고 done (<memo_id>) · error: <까닭> 으로 바꾼다
use crate::js;

/// 시트 이름 (_memoking 폴더 안)
pub const SHEET_NAME: &str = "AI 받은함";
pub const COLUMNS: [&str; 7] = ["req_id", "action", "memo_id", "folder", "body", "find", "status"];
/// 한 차례에 처리하는 요청 수
pub const BATCH: usize = 20;
/// 처리를 마친 줄은 최근 이만큼만 남긴다
pub const KEEP_DONE: usize = 20;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Row {
    pub req_id: String,
    pub action: String,
    pub memo_id: String,
    pub folder: String,
    pub body: String,
    pub find: String,
    pub status: String,
}

/// 처리할 일 하나
#[derive(Clone, Debug, PartialEq)]
pub enum Job {
    Create { folder: String, body: String },
    Append { memo_id: String, body: String },
    Replace { memo_id: String, find: String, body: String },
    Trash { memo_id: String },
}

/// RFC 4180 CSV → 줄마다 칸들. 따옴표 안의 쉼표 · 줄바꿈 · "" 를 읽고, 맨 앞 BOM · 끝의 빈 줄은 뗀다
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (mut rows, mut row, mut cell) = (vec![], vec![], String::new());
    let (mut quoted, mut any) = (false, false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        any = true;
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    cell.push('"');
                }
                '"' => quoted = false,
                _ => cell.push(c),
            }
            continue;
        }
        match c {
            '"' => quoted = true,
            ',' => row.push(std::mem::take(&mut cell)),
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' | '\r' => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
                any = false;
            }
            _ => cell.push(c),
        }
    }
    if any {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// 칸들 → CSV (쉼표 · 따옴표 · 줄바꿈 · 앞뒤 빈칸이 든 칸만 따옴표로, 줄 끝은 \r\n)
pub fn to_csv(rows: &[Vec<String>]) -> String {
    let cell = |s: &String| {
        if s.contains([',', '"', '\n', '\r']) || s.starts_with(' ') || s.ends_with(' ') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.clone()
        }
    };
    rows.iter().map(|r| r.iter().map(cell).collect::<Vec<_>>().join(",") + "\r\n").collect()
}

/// 시트 CSV → 줄들. 첫 줄에 req_id 가 있으면 머리 줄로 보고 열 이름으로(열 차례가 바뀌어도), 아니면 7열 차례대로 읽는다 (모르는 열은 버린다)
pub fn rows_from_csv(text: &str) -> Vec<Row> {
    let mut cells = parse_csv(text);
    let header: Vec<String> = cells.first().map(|h| h.iter().map(|c| js::trim(c).to_lowercase()).collect()).unwrap_or_default();
    let named = header.iter().any(|h| h == "req_id");
    let at: Vec<Option<usize>> = COLUMNS.iter().enumerate().map(|(i, name)| if named { header.iter().position(|h| h == name) } else { Some(i) }).collect();
    if named {
        cells.remove(0);
    }
    cells
        .into_iter()
        .filter(|c| c.iter().any(|v| !js::trim(v).is_empty())) // 빈 줄
        .map(|c| {
            let get = |i: usize| at[i].and_then(|j| c.get(j)).cloned().unwrap_or_default();
            Row { req_id: get(0), action: get(1), memo_id: get(2), folder: get(3), body: get(4), find: get(5), status: get(6) }
        })
        .collect()
}

/// 줄들 → 시트에 올릴 CSV (머리 줄 포함)
pub fn rows_to_csv(rows: &[Row]) -> String {
    let mut cells = vec![COLUMNS.iter().map(|s| s.to_string()).collect::<Vec<_>>()];
    cells.extend(rows.iter().map(|r| vec![r.req_id.clone(), r.action.clone(), r.memo_id.clone(), r.folder.clone(), r.body.clone(), r.find.clone(), r.status.clone()]));
    to_csv(&cells)
}

fn pending(r: &Row) -> bool {
    js::trim(&r.status).eq_ignore_ascii_case("pending")
}

/// 처리할 줄 (최대 BATCH 개): (줄 번호, 할 일 또는 거절 까닭)
///   status 가 pending 인 줄만. 이미 처리한(또는 이번에 앞에서 본) req_id 는 거절해 같은 요청을 두 번 하지 않는다
pub fn plan(rows: &[Row]) -> Vec<(usize, Result<Job, String>)> {
    let mut seen: std::collections::HashSet<String> = rows.iter().filter(|r| !pending(r)).map(|r| js::trim(&r.req_id).to_string()).collect();
    let mut out = vec![];
    for (i, r) in rows.iter().enumerate() {
        if out.len() >= BATCH {
            break;
        }
        if !pending(r) {
            continue;
        }
        let id = js::trim(&r.req_id).to_string();
        let job = if id.is_empty() {
            Err("req_id 가 비었어요".to_string())
        } else if !seen.insert(id) {
            Err("이미 처리한 req_id 예요".to_string())
        } else {
            job_of(r)
        };
        out.push((i, job));
    }
    out
}

fn job_of(r: &Row) -> Result<Job, String> {
    let memo_id = js::trim(&r.memo_id).to_string();
    let need_memo = || {
        if memo_id.is_empty() {
            Err("memo_id 가 비었어요".to_string())
        } else if memo_id.contains(['/', '\\']) || memo_id.contains("..") {
            Err("쓸 수 없는 memo_id 예요".to_string())
        } else {
            Ok(memo_id.clone())
        }
    };
    let body = js::trim(&r.body).to_string();
    match js::trim(&r.action).to_lowercase().as_str() {
        "create" => {
            if body.is_empty() {
                return Err("body 가 비었어요".into());
            }
            let raw = js::trim(&r.folder);
            let folder = crate::memo_file::clean_folder_name(raw);
            let lower = raw.to_lowercase();
            if raw.contains(['/', '\\']) || raw.contains("..") || lower.contains("_memoking") || (!raw.is_empty() && folder.is_empty()) {
                return Err("쓸 수 없는 folder 예요 (/ \\ .. _memoking 은 안 돼요)".into());
            }
            Ok(Job::Create { folder, body })
        }
        "append" => {
            let memo_id = need_memo()?;
            if body.is_empty() {
                return Err("body 가 비었어요".into());
            }
            Ok(Job::Append { memo_id, body })
        }
        "replace" => {
            let memo_id = need_memo()?;
            if r.find.is_empty() {
                return Err("find 가 비었어요".into());
            }
            Ok(Job::Replace { memo_id, find: r.find.clone(), body: r.body.clone() })
        }
        "trash" => Ok(Job::Trash { memo_id: need_memo()? }),
        "" => Err("action 이 비었어요".into()),
        other => Err(format!("모르는 action 이에요 ({other}). create · append · replace · trash 중 하나")),
    }
}

/// 처리 결과를 status 에 적고, 처리를 마친 줄은 최근 KEEP_DONE 개만 남긴다 (아직 pending 인 줄은 모두 남김)
///   results: (줄 번호, 성공이면 Ok(memo_id) · 실패면 Err(까닭))
pub fn finish(mut rows: Vec<Row>, results: &[(usize, Result<String, String>)]) -> Vec<Row> {
    for (i, r) in results {
        if let Some(row) = rows.get_mut(*i) {
            row.status = match r {
                Ok(id) => format!("done ({id})"),
                Err(e) => format!("error: {e}"),
            };
        }
    }
    let done = rows.iter().filter(|r| !pending(r)).count();
    let mut drop = done.saturating_sub(KEEP_DONE);
    rows.retain(|r| {
        if drop > 0 && !pending(r) {
            drop -= 1;
            return false;
        }
        true
    });
    rows
}

/// 시트 CSV 한 번 처리: 처리할 줄마다 apply(job) → memo_id | 까닭 을 부르고 결과를 적은 새 CSV · 해낸 수 (처리할 것이 없으면 None)
pub fn run(csv: &str, mut apply: impl FnMut(&Job) -> Result<String, String>) -> Option<(String, usize)> {
    let rows = rows_from_csv(csv);
    let todo = plan(&rows);
    if todo.is_empty() {
        return None;
    }
    let results: Vec<(usize, Result<String, String>)> = todo.into_iter().map(|(i, job)| (i, job.and_then(|j| apply(&j)))).collect();
    let done = results.iter().filter(|(_, r)| r.is_ok()).count();
    Some((rows_to_csv(&finish(rows, &results)), done))
}

/// find 가 본문에 정확히 한 번 있을 때만 바꾼다
pub fn replace_once(text: &str, find: &str, with: &str) -> Result<String, String> {
    match text.matches(find).count() {
        0 => Err("find 가 본문에 없어요".into()),
        1 => Ok(text.replacen(find, with, 1)),
        n => Err(format!("find 가 본문에 {n}번 있어요 (한 번만 있는 글로 적어 주세요)")),
    }
}

/// 메모 끝에 줄을 바꿔 덧붙인다
pub fn append_text(body: &str, add: &str) -> String {
    format!("{}\n{}", js::trim(body), js::trim(add))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_round_trip_keeps_commas_quotes_and_lines() {
        let rows = vec![vec!["a,b".to_string(), "say \"hi\"".into(), "줄\n바꿈".into(), " 앞빈칸".into(), String::new()]];
        let csv = to_csv(&rows);
        assert_eq!(parse_csv(&csv), rows);
        assert_eq!(parse_csv("\u{feff}a,b\r\nc,\"d\r\ne\"\r\n"), vec![vec!["a", "b"], vec!["c", "d\r\ne"]]);
    }

    #[test]
    fn plan_checks_each_action() {
        let row = |id: &str, action: &str, memo: &str, folder: &str, body: &str, find: &str| Row {
            req_id: id.into(),
            action: action.into(),
            memo_id: memo.into(),
            folder: folder.into(),
            body: body.into(),
            find: find.into(),
            status: "pending".into(),
        };
        let mut rows = vec![
            row("1", "create", "", "업무", "# 새 메모", ""),
            row("2", "create", "", "../밖", "# x", ""),
            row("3", "create", "", "_memoking", "# x", ""),
            row("4", "append", "", "", "더", ""),
            row("5", "replace", "m1", "", "새", ""),
            row("6", "trash", "../m", "", "", ""),
            row("7", "dance", "m1", "", "", ""),
            row("1", "create", "", "", "# 다시", ""),
        ];
        rows.push(Row { status: "done (m9)".into(), ..row("8", "trash", "m9", "", "", "") });
        rows.push(row("8", "trash", "m9", "", "", ""));
        let got: Vec<bool> = plan(&rows).iter().map(|(_, j)| j.is_ok()).collect();
        assert_eq!(got, vec![true, false, false, false, false, false, false, false, false]);
        assert_eq!(plan(&rows)[0].1, Ok(Job::Create { folder: "업무".into(), body: "# 새 메모".into() }));
    }

    #[test]
    fn finish_writes_status_and_keeps_recent_done() {
        let rows: Vec<Row> = (0..30).map(|i| Row { req_id: i.to_string(), status: if i < 25 { "done (x)".into() } else { "pending".into() }, ..Default::default() }).collect();
        let out = finish(rows, &[(25, Ok("m1".into())), (26, Err("잠긴 메모예요".into()))]);
        assert_eq!(out.iter().filter(|r| !pending(r)).count(), KEEP_DONE);
        assert_eq!(out.len(), KEEP_DONE + 3);
        assert!(out.iter().any(|r| r.req_id == "25" && r.status == "done (m1)") && out.iter().any(|r| r.req_id == "26" && r.status == "error: 잠긴 메모예요"));
    }

    #[test]
    fn run_writes_results_and_never_twice() {
        let csv = "req_id,action,memo_id,folder,body,find,status\r\n1,create,,,# 새,,pending\r\n2,trash,m9,,,,pending\r\n";
        let mut calls = 0;
        let (out, done) = run(csv, |job| {
            calls += 1;
            match job {
                Job::Create { .. } => Ok("new1".into()),
                _ => Err("그런 memo_id 의 메모가 없어요".into()),
            }
        })
        .unwrap();
        assert_eq!((calls, done), (2, 1));
        let status: Vec<String> = rows_from_csv(&out).into_iter().map(|r| r.status).collect();
        assert_eq!(status, vec!["done (new1)", "error: 그런 memo_id 의 메모가 없어요"]);
        assert!(run(&out, |_| panic!("다시 처리하지 않는다")).is_none());
    }

    #[test]
    fn replace_only_once() {
        assert_eq!(replace_once("가 나 다", "나", "라"), Ok("가 라 다".into()));
        assert!(replace_once("가 나 나", "나", "라").is_err() && replace_once("가", "나", "라").is_err());
        assert_eq!(append_text("# 제목\n본문\n\n", "  더  "), "# 제목\n본문\n더");
    }
}
