//! LLM 에이전트용 색인(_memoking/index.json) — 요약 · 키워드 · 연결 · 관련도.
//!   app/js/core/indexer.js (indexOutput · indexKey · tokenize · AGENT_GUIDE) 와 korean-nouns.js
use crate::body;
use crate::js::{self, re};
use crate::memo_file::Meta;
use fancy_regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const INDEX_SCHEMA: &str = "memoking.index/v1";
const SUMMARY_LENGTH: usize = 200;
const KEYWORD_COUNT: usize = 6;
const RELATED_COUNT: usize = 8;
const SIMILAR_MIN: f64 = 0.08;

/// 색인에 넣을 메모 하나 (파일이 있는 메모만)
pub struct IndexMemo<'a> {
    pub id: &'a str,
    /// 메모 폴더 기준 경로 ("업무/회의.md")
    pub file: &'a str,
    pub meta: &'a Meta,
    pub body: &'a str,
}

/// 색인, 파일에 쓸 글, 비교 열쇠 (generatedAt 만 다르면 같은 열쇠)
pub struct IndexOutput {
    pub index: Value,
    pub key: String,
    pub text: String,
}

// 한국어 조사 · 어미 (긴 것부터 떼어 낸다)
const JOSA: [&str; 41] = [
    "에서부터", "으로부터", "이라는", "이라고", "에게서", "한테서", "까지는", "부터는", "에서는", "으로는", "이에요", "입니다", "했다", "에서", "에게", "한테", "으로", "까지", "부터", "처럼", "보다", "라는", "이나",
    "하고", "이다", "이랑", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만", "랑", "나",
];
// 조사는 앞 글자의 받침과 맞을 때만 뗀다 ("하와이" 의 "이", "소아과" 의 "과" 는 조사가 아니다)
const AFTER_BATCHIM: [&str; 14] = ["이", "은", "을", "과", "으로", "으로는", "으로부터", "이나", "이랑", "이다", "이에요", "입니다", "이라는", "이라고"];
const AFTER_VOWEL: [&str; 8] = ["가", "는", "를", "와", "나", "랑", "로", "라는"];
const STOPWORDS: [&str; 25] = [
    "그리고", "그러나", "하지만", "그래서", "또는", "이것", "저것", "그것", "있다", "없다", "하다", "되다", "the", "and", "for", "with", "that", "this", "are", "was", "you", "not", "but", "from", "have",
];

static WORD: LazyLock<Regex> = LazyLock::new(|| re(r"[\p{L}\p{N}]+"));
static HANGUL_END: LazyLock<Regex> = LazyLock::new(|| re(r"\p{Script=Hangul}$"));
static TAIL_ANY_SET: LazyLock<Vec<&str>> = LazyLock::new(|| TAIL_ANY.split_whitespace().collect());
static TAIL_NOUN_SET: LazyLock<HashSet<&str>> = LazyLock::new(|| TAIL_NOUN.split_whitespace().collect());
static NOUN_SET: LazyLock<HashSet<&str>> = LazyLock::new(|| [TAIL_ANY, TAIL_NOUN, NOUNS].iter().flat_map(|t| t.split_whitespace()).collect());

/// JS 의 s.length (UTF-16 단위)
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

// 끝 글자가 조사처럼 생겼지만 낱말의 일부인가 ("고양이" · "부서회의" 는 그대로, "위원회의" 는 위원회 + 의)
fn ends_in_noun(word: &str, josa: &str) -> bool {
    if TAIL_ANY_SET.iter().any(|n| word.ends_with(n)) {
        return true;
    }
    let last2 = &word[word.char_indices().nth_back(1).map_or(0, |(i, _)| i)..];
    let stem = &word[..word.len() - josa.len()];
    let known_noun = stem.char_indices().any(|(i, _)| len16(&stem[i..]) >= 2 && NOUN_SET.contains(&stem[i..]));
    len16(word) >= 4 && TAIL_NOUN_SET.contains(last2) && !known_noun
}

fn josa_fits(word: &str, josa: &str) -> bool {
    let prev = word[..word.len() - josa.len()].chars().next_back().map_or(0, u32::from);
    let Some(syllable) = prev.checked_sub(0xac00).filter(|s| *s <= 11171) else { return true }; // 한글 음절이 아니면 그대로
    let batchim = syllable % 28;
    if AFTER_BATCHIM.contains(&josa) {
        return batchim != 0;
    }
    if AFTER_VOWEL.contains(&josa) {
        return batchim == 0 || (josa == "로" && batchim == 8);
    }
    true
}

/// 글 → 낱말 (소문자, 조사 뗀 것, 두 글자 이상, 불용어 · 숫자만인 것 빼고)
pub fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    WORD.find_iter(&lower)
        .flatten()
        .filter_map(|m| {
            let mut word = m.as_str();
            // 끝 글자가 ASCII 면 한글일 수 없다 (낱말마다 정규식을 돌리면 색인이 느렸다)
            if !word.ends_with(|c: char| c.is_ascii()) && HANGUL_END.is_match(word).unwrap_or(false) {
                // 뗀 뒤 두 글자 이상 남을 때만 뗀다 ("사과" 의 "과" 는 조사가 아님)
                let n = len16(word);
                let josa = JOSA.iter().find(|j| word.ends_with(**j) && n >= len16(j) + 2 && josa_fits(word, j));
                if let Some(j) = josa.filter(|j| !ends_in_noun(word, j)) {
                    word = &word[..word.len() - j.len()];
                }
            }
            (len16(word) >= 2 && !STOPWORDS.contains(&word) && !word.bytes().all(|b| b.is_ascii_digit())).then(|| word.to_string())
        })
        .collect()
}

// 제목을 뺀 본문 앞부분을 문장 단위로 잘라 요약으로 (추출 요약)
fn summary_of(plain: &[String]) -> String {
    let mut summary = String::new();
    for line in plain.iter().skip(1) {
        let next = if summary.is_empty() { line.clone() } else { format!("{summary} {line}") };
        if len16(&next) > SUMMARY_LENGTH {
            if summary.is_empty() {
                summary = format!("{}…", js::slice16(line, SUMMARY_LENGTH - 1));
            } else {
                summary.push_str(" …");
            }
            break;
        }
        summary = next;
    }
    summary
}

// 낱말 → 무게 (넣은 차례대로 — JS Map 처럼, 더하는 차례가 같아야 소수 끝자리까지 같다)
pub type Vector = Vec<(String, f64)>;

pub fn tfidf_vectors(docs: Vec<Vec<String>>) -> Vec<Vector> {
    let mut df: HashMap<String, f64> = HashMap::new();
    let tfs: Vec<Vector> = docs
        .into_iter()
        .map(|tokens| {
            let mut tf: Vector = vec![];
            let mut at: HashMap<String, usize> = HashMap::new();
            for t in tokens {
                match at.get(&t) {
                    Some(&i) => tf[i].1 += 1.0,
                    None => {
                        at.insert(t.clone(), tf.len());
                        tf.push((t, 1.0));
                    }
                }
            }
            for (t, _) in &tf {
                *df.entry(t.clone()).or_default() += 1.0;
            }
            tf
        })
        .collect();
    let n = tfs.len() as f64;
    tfs.into_iter()
        .map(|tf| {
            let mut vec: Vector = tf
                .into_iter()
                .map(|(t, count)| {
                    let w = (1.0 + count.ln()) * (1.0 + n / df[&t]).ln();
                    (t, w)
                })
                .collect();
            let norm = vec.iter().fold(0.0, |s, (_, w)| s + w * w).sqrt();
            let norm = if norm == 0.0 { 1.0 } else { norm };
            for v in &mut vec {
                v.1 /= norm;
            }
            vec
        })
        .collect()
}

fn round(v: f64) -> f64 {
    js::round(v * 1000.0) / 1000.0
}

fn build_index(memos: &[IndexMemo], now: &str) -> Value {
    let mut sorted: Vec<&IndexMemo> = memos.iter().collect();
    sorted.sort_by(|a, b| js::locale_cmp(a.file, b.file, true));
    let ids: HashSet<&str> = sorted.iter().map(|m| m.id).collect();
    let titles: Vec<String> = sorted.iter().map(|m| body::extract_title(m.body)).collect();

    // 제목은 두 번 넣어 가중치를 높인다
    let plains: Vec<Vec<String>> = sorted.iter().map(|m| body::plain_lines(m.body, usize::MAX)).collect();
    let vectors = tfidf_vectors((0..sorted.len()).map(|i| tokenize(&format!("{0} {0} {1}", titles[i], plains[i].join(" ")))).collect());

    // id 로 찾는다 (JS Map 처럼 — 같은 id 가 둘이면 뒤의 것, 차례는 처음 나온 곳)
    let mut links: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut order = vec![];
    for m in &sorted {
        if links.insert(m.id, m.meta.links.iter().map(String::as_str).filter(|id| ids.contains(id) && *id != m.id).collect()).is_none() {
            order.push(m.id);
        }
    }
    let mut backlinks: HashMap<&str, Vec<&str>> = order.iter().map(|id| (*id, vec![])).collect();
    for from in &order {
        for to in &links[from] {
            backlinks.get_mut(to).expect("링크는 있는 id 만").push(from);
        }
    }

    // 같은 낱말을 가진 메모끼리만 곱해 더한다 (역색인) — 모든 쌍을 견주면 메모가 많을 때 느리다
    let mut postings: HashMap<&str, Vec<(usize, f64)>> = HashMap::new();
    for (i, vec) in vectors.iter().enumerate() {
        for (t, w) in vec {
            postings.entry(t.as_str()).or_default().push((i, *w));
        }
    }
    let mut sims = vec![0.0; sorted.len()];
    let entries: Vec<Value> = sorted
        .iter()
        .enumerate()
        .map(|(i, memo)| {
            let vec = &vectors[i];
            sims.fill(0.0);
            for (t, w) in vec {
                for (j, w2) in &postings[t.as_str()] {
                    sims[*j] += w * w2;
                }
            }
            let mut ranked: Vec<&(String, f64)> = vec.iter().collect();
            ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| js::locale_cmp(&a.0, &b.0, false)));
            let keywords: Vec<&str> = ranked.iter().take(KEYWORD_COUNT).map(|(t, _)| t.as_str()).collect();

            let (out, back) = (&links[memo.id], &backlinks[memo.id]);
            // 점수만 먼저 모아 위 몇 개만 (같은 점수는 파일 이름 순 = sorted 의 차례)
            let mut scored: Vec<(f64, usize)> = (0..sorted.len())
                .filter(|j| *j != i)
                .filter_map(|j| {
                    let id = sorted[j].id;
                    let sim = if sims[j] >= SIMILAR_MIN { sims[j] } else { 0.0 };
                    let score = (if out.contains(&id) { 0.6 } else { 0.0 }) + (if back.contains(&id) { 0.4 } else { 0.0 }) + sim;
                    (score > 0.0).then(|| (round(score.min(1.0)), j))
                })
                .collect();
            scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
            let related: Vec<Value> = scored
                .iter()
                .take(RELATED_COUNT)
                .map(|&(score, j)| {
                    let other = sorted[j];
                    let reasons: Vec<&str> = [(out.contains(&other.id), "link"), (back.contains(&other.id), "backlink"), (sims[j] >= SIMILAR_MIN, "similar")]
                        .into_iter()
                        .filter_map(|(on, r)| on.then_some(r))
                        .collect();
                    json!({ "id": other.id, "file": other.file, "title": titles[j], "score": js::num(score), "similarity": js::num(round(sims[j])), "reasons": reasons })
                })
                .collect();

            json!({
                "id": memo.id,
                "file": memo.file,
                "title": titles[i],
                "summary": summary_of(&plains[i]),
                "headings": body::extract_headings(memo.body),
                "tags": body::extract_tags(memo.body),
                "keywords": keywords,
                "created": memo.meta.created,
                "updated": memo.meta.updated,
                "color": memo.meta.color,
                "pinned": memo.meta.pinned,
                "chars": plains[i].iter().map(|l| len16(l)).sum::<usize>(),
                "attachments": body::extract_media(memo.body).into_iter().map(|m| m.src).collect::<Vec<_>>(),
                "links": out,
                "backlinks": back,
                "related": related,
            })
        })
        .collect();

    json!({ "schema": INDEX_SCHEMA, "generatedAt": now, "guide": "_memoking/README.md", "memoCount": entries.len(), "memos": entries })
}

/// generatedAt 만 다른 색인은 같은 열쇠 (불필요한 동기화 없게) — indexKey
pub fn index_key(index: &Value) -> String {
    let mut index = index.clone();
    index["generatedAt"] = Value::Null;
    index.to_string()
}

/// 색인과 파일에 쓸 글 · 비교 열쇠 — indexOutput. now: generatedAt (JS toISOString 모양, 예 "2026-11-17T03:04:05.678Z")
pub fn index_output(memos: &[IndexMemo], now: &str) -> IndexOutput {
    let index = build_index(memos, now);
    let key = index_key(&index);
    let text = format!("{}\n", serde_json::to_string_pretty(&index).expect("색인은 늘 JSON 으로 쓸 수 있다"));
    IndexOutput { index, key, text }
}

// ---------- 낱말 묶음 (korean-nouns.js) ----------
// shortcut: 손으로 고른 흔한 생활 · 업무 낱말뿐이다, 놓치는 낱말이 잦으면 JS 와 함께 더한다

/// 이 말로 끝나면 끝 글자는 조사가 아니다 ("길고양이" · "물놀이")
const TAIL_ANY: &str = "
    고양이 호랑이 원숭이 어린이 젊은이 늙은이 지은이 떡볶이 손잡이 목걸이 귀걸이 옷걸이 달팽이 올챙이 지팡이 곰팡이 엉덩이 구덩이
    멍멍이 나들이 집들이 해돋이 미닫이 맞벌이 놀이 먹이 풀이 바나나 사우나 카나나 난이도 만족도 완성도 정확도 해상도 선호도 인지도
    고속도로 횡단보도 산부인과 첫사랑 짝사랑 팀회의 민주주의 자본주의 사회주의 완벽주의
";

/// 끝 글자가 조사처럼 생긴 두 글자 명사 — 앞에 두 글자 이상 붙은 말에서만 남긴다 ("부서회의")
const TAIL_NOUN: &str = "
    회의 주의 정의 강의 문의 논의 동의 합의 협의 편의 결의 심의 건의 항의
    결과 효과 성과 온도 속도 각도 습도 강도 농도 밀도 제도 지도 용도 정도 태도 한도 연도 진도 빈도
    도로 피로 위로 휴가 추가 허가 대가 주가 화가 여가 귀가
";

/// 흔한 명사 — 조사를 뗀 말이 이것으로 끝나면 명사 + 조사다 ("위원회의" = 위원회 + 의)
const NOUNS: &str = "
    사회 국회 기회 대회 학회 교회 협회 총회 위원회 이사회 동호회 동창회 전시회 발표회 설명회 간담회 박람회 음악회 운동회 송년회
    연주회 후원회 협의회 학생회 연합회 공청회 토론회 시사회 환영회 송별회 반상회 청문회 조합 모임 행사 세미나 워크숍 미팅
    회사 부서 팀장 대리 과장 부장 사장 대표 직원 사원 담당 담당자 책임자 관리자 사용자 고객 손님 거래처 업체 협력사 본사 지사
    업무 프로젝트 계획 일정 스케줄 약속 예약 마감 기한 보고 보고서 문서 자료 파일 메모 노트 회의록 기록 목록 정리 요약 초안
    내용 제목 주제 항목 문제 질문 답변 의견 생각 이유 원인 해결 방법 방안 절차 과정 단계 상태 상황 조건 기준 규칙 규정
    계약 계약서 견적 견적서 주문 발주 납품 배송 결제 입금 송금 이체 계좌 통장 카드 현금 영수증 계산서 세금 비용 예산 매출
    가격 단가 금액 수량 재고 할인 수수료 월급 급여 월세 관리비 보증금 대출 이자 보험 보험증 연금 적금
    제품 상품 서비스 기능 버전 출시 배포 개발 설계 디자인 시안 테스트 검사 검토 수정 변경 개선 오류 버그 장애 서버 데이터
    프로그램 시스템 화면 버튼 설정 계정 아이디 비밀번호 암호 이메일 메일 문자 전화 번호 연락처 주소 링크 사진 이미지 그림 영상
    동영상 음성 녹음 메시지 페이지 사이트 홈페이지 블로그 인터넷 와이파이 컴퓨터 노트북 휴대폰 핸드폰 스마트폰 배터리 충전기
    병원 의사 간호사 진료 검진 수술 처방 약국 치과 안과 내과 외과 소아과 피부과 한의원 건강 운동 헬스장 수영 달리기 산책
    학교 학원 수업 숙제 시험 성적 학생 선생님 교수 논문 연구 실험 특허 출원 발명 발명자 변호사 변리사 세무사 회계사
    가족 부모 어머니 아버지 엄마 아빠 아이 아기 친구 동료 선배 후배 이웃 생일 생신 결혼 결혼식 기념일 선물 축하 명절 여행
    비행기 기차 버스 지하철 택시 자동차 주차 주차장 공항 역 정류장 숙소 호텔 펜션 예매 티켓 여권 제주 제주도 서울 부산
    식당 맛집 카페 메뉴 요리 재료 음식 점심 저녁 아침 장보기 마트 시장 편의점 배달 택배 청소 빨래 설거지 쓰레기 분리수거
    날짜 시간 오전 오후 주말 평일 휴일 연휴 방학 이번 다음 지난 올해 내년 작년 오늘 내일 어제 날씨 기온 온도 습도
    책 도서 독서 영화 드라마 음악 노래 게임 취미 사진첩 일기 아이디어 목표 습관 감사 기도 공부 영어 단어 문장
";

pub const AGENT_GUIDE: &str = r##"# 메모킹 폴더 안내 (LLM 에이전트용)

이 폴더는 메모킹 앱의 메모 저장소입니다. **먼저 `_memoking/index.json` 을 읽고**, 필요한 메모 파일만 여세요.

## 구조
- `*.md` — 메모 1개 = 파일 1개. YAML 머리말 + 마크다운 본문. 첫 줄이 제목, 파일명도 제목을 따름.
- `attachments/` — 메모에 넣은 파일. 이미지·소리·동영상은 `![설명](attachments/파일)`, 그 밖의 파일은 `[파일명](attachments/파일)` 로 참조.
- 본문 서식은 마크다운 + 일부 인라인 HTML: 밑줄 `<u>`, 하이라이트 `<mark>`, 글자 색 `<span style="color: …">` (태그를 빼면 글자만 남음).
- 링크 카드: 한 줄에 `[페이지 제목](주소 "미리보기")` 만 있으면 앱에서 미리보기 카드로 보임. 페이지 설명은 `_memoking/link-previews.json` 에 주소별로 있음.
- `_memoking/index.json` — 모든 메모의 요약·키워드·연결·관련도 (앱이 자동 갱신).
- `_memoking/trash/` — 삭제된 메모 (검색 대상 아님).

## 메모 머리말
| 키 | 뜻 |
|---|---|
| id | 메모 고유 id (파일명이 바뀌어도 유지) |
| created / updated | 만든 시각 / 고친 시각 (ISO 8601) |
| color | 스티커 색 |
| pinned | 상단 고정 여부 (pinnedAt: 상단 고정한 때) |
| links | 사용자가 직접 연결한 메모들의 id |

## index.json의 memos[] 항목
| 키 | 뜻 |
|---|---|
| id, file, title | 메모 id, 폴더 기준 파일 경로, 제목 |
| summary | 본문 앞부분 추출 요약 |
| headings, keywords | 소제목 목록, 핵심어 (TF-IDF) |
| tags | 본문의 #태그 (사용자가 붙인 분류) |
| links / backlinks | 이 메모가 연결한 메모 / 이 메모를 연결한 메모 (id) |
| related | 관련 메모 목록. score(0~1) 높은 순. reasons: link(직접 연결), backlink(역연결), similar(내용 유사) |
| attachments | 첨부 파일 경로 |

## 권장 사용법
1. index.json에서 title·summary·keywords로 후보를 찾는다.
2. 후보의 related를 따라 score 높은 메모를 함께 확인한다.
3. 필요한 메모의 file을 열어 본문을 읽는다.

## 새 메모 쓰기 (_memoking/받은 메모)
메모킹은 Google Drive 에서 메모킹이 만든 파일만 볼 수 있어서, **새 파일을 만들면 휴대폰 · 다른 PC 에 나타나지 않을 수 있습니다.**
새 메모는 `_memoking/받은 메모/빈 메모 001.md` ~ `100.md` 가운데 **안내 주석만 들어 있는 빈 칸 하나를 골라, 그 파일 전체를 새 메모 글로 덮어쓰세요** (새 파일을 만들거나 지우지 말 것).
- 첫 줄이 제목, 본문에 `#태그`. 색을 정하려면 맨 위에 `---\ncolor: blue\n---` 머리말 (yellow · green · pink · purple · blue · gray · charcoal).
- 켜져 있는 메모킹(PC · 휴대폰)이 몇 초 ~ 몇 분 안에 보통 메모로 옮기고 그 칸을 다시 비웁니다.
- 기존 메모를 고칠 때는 그 메모 파일을 같은 자리에서 덮어쓰세요 (지우고 새로 만들지 말 것).
"##;
