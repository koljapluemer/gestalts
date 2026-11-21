//! Publishing a draft and opening it from its link on the lesson domain.

mod common;

use axum::http::StatusCode;
use common::Server;
use gestalts_teacher::Limits;
use serde_json::{Value, json};

const RUNTIME: &str = "0123456789abcdef";

struct Draft {
    base: String,
    id: String,
    package: String,
    cookie: String,
}

async fn draft(s: &Server) -> Draft {
    let cookie = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&cookie), Some(json!({ "title": "der, die, das" }))).await;
    let (id, package) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    // a player for the runtime the draft says it was made against
    let player = s.state.data.join("runtime").join(RUNTIME);
    std::fs::create_dir_all(player.join("assets")).unwrap();
    std::fs::write(player.join("index.html"), "<!doctype html><html><head><title>Lesson</title></head><body></body></html>").unwrap();
    std::fs::write(player.join("assets/index.js"), "console.log(1)").unwrap();
    Draft { base: format!("/api/drafts/{id}"), id, package, cookie }
}

impl Draft {
    async fn write(&self, s: &Server, fields: &str, view: &str) -> (StatusCode, Value) {
        let (p, id) = (&self.package, &self.id);
        let members = format!("[gestalt-{p}.noun.1, haus]");
        let view = format!("id: {id}\ngestalt: view@2\ntitle: Artikel\nsource: {view:?}\nreads: [{p}/noun@1, practice-event@1]\nwrites: [practice-event@1]\npackage: {p}\nruntime: '{RUNTIME}'\nmembers: {members}\n");
        let noun = format!("id: gestalt-{p}.noun.1\ngestalt: gestalt@1\nname: {p}/noun\nversion: 1\nfields:\n{fields}");
        let w = json!([{ "id": id, "text": view }, { "id": format!("gestalt-{p}.noun.1"), "text": noun }, { "id": "haus", "text": format!("id: haus\ngestalt: {p}/noun@1\nword: Haus\n") }]);
        let (status, body, _) = s.call("POST", &format!("{}/sync/write", self.base), Some(&self.cookie), Some(w)).await;
        (status, body)
    }

    async fn publish(&self, s: &Server) -> (StatusCode, Value) {
        let (status, body, _) = s.call("POST", &format!("{}/publish", self.base), Some(&self.cookie), None).await;
        (status, body)
    }
}

const WORD: &str = "  word: { type: string, required: true }\n";
const VIEW: &str = "export default function View() { return <div className=\"h-full\">Hallo</div>; }\n";

#[tokio::test]
async fn a_published_lesson_opens_from_its_link_until_it_is_switched_off() {
    let s = Server::new(Limits::default());
    let d = draft(&s).await;
    assert_eq!(d.write(&s, WORD, VIEW).await.0, StatusCode::NO_CONTENT);
    let (status, p) = d.publish(&s).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    let lesson = p["id"].as_str().unwrap().to_owned();
    assert_eq!(lesson.len(), 22);
    assert_eq!(p["url"], format!("https://lessons.example/l/{lesson}"));

    // the link: the player for its runtime, with a <base> there, private and not indexed
    let (status, h, page) = s.lessons(&format!("/l/{lesson}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8(page).unwrap().contains(&format!("<base href=\"/runtime/{RUNTIME}/\">")));
    assert_eq!(h["x-robots-tag"], "noindex, nofollow");
    assert_eq!(h["referrer-policy"], "no-referrer");
    assert!(h["content-security-policy"].to_str().unwrap().contains("frame-ancestors 'none'"));
    assert_eq!(s.lessons(&format!("/runtime/{RUNTIME}/assets/index.js")).await.0, StatusCode::OK);

    // its current version: a deck of its ymls and a compiled view
    let (_, _, current) = s.lessons(&format!("/l/{lesson}/current")).await;
    let path = serde_json::from_slice::<Value>(&current).unwrap()["manifest"].as_str().unwrap().to_owned();
    let (status, h, manifest) = s.lessons(&path).await;
    assert_eq!((status, h["access-control-allow-origin"].to_str().unwrap()), (StatusCode::OK, "*"));
    let manifest: Value = serde_json::from_slice(&manifest).unwrap();
    assert_eq!((manifest["format"].as_str(), manifest["runtime"].as_str(), manifest["title"].as_str()), (Some("lesson@1"), Some(RUNTIME), Some("Artikel")));
    let base = path.trim_end_matches("manifest.json");
    let (_, _, js) = s.lessons(&format!("{base}{}", manifest["view"].as_str().unwrap())).await;
    assert!(String::from_utf8(js).unwrap().contains("Hallo"));
    let (_, _, ymls) = s.lessons(&format!("{base}ymls.json")).await;
    let ids: Vec<String> = serde_json::from_slice::<Vec<Value>>(&ymls).unwrap().iter().map(|y| y["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids, [format!("gestalt-{}.noun.1", d.package), "haus".to_owned()], "members only, never the view");
    assert_eq!(s.lessons(&format!("{base}index.json")).await.0, StatusCode::OK);

    // the same draft again is the same version
    assert_eq!(d.publish(&s).await.1["manifest"], json!(path));

    // switched off
    assert_eq!(s.call("DELETE", &format!("{}/publication", d.base), Some(&d.cookie), None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.lessons(&format!("/l/{lesson}/current")).await.0, StatusCode::GONE);
    assert_eq!(s.lessons(&format!("/l/{lesson}")).await.0, StatusCode::GONE);
    // publishing again switches it back on, at the same link
    let (_, again) = d.publish(&s).await;
    assert_eq!((again["id"].as_str(), again["revoked"].clone()), (Some(lesson.as_str()), Value::Null));
    assert_eq!(s.lessons(&format!("/l/{lesson}/current")).await.0, StatusCode::OK);
}

#[tokio::test]
async fn what_may_not_go_out() {
    let s = Server::new(Limits::default());
    let d = draft(&s).await;
    d.write(&s, WORD, VIEW).await;
    assert_eq!(d.publish(&s).await.0, StatusCode::OK);

    // a published gestalt keeps its structure
    assert_eq!(d.write(&s, &format!("{WORD}  gender: {{ type: string }}\n"), VIEW).await.0, StatusCode::NO_CONTENT);
    let (status, body) = d.publish(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["problems"][0].as_str().unwrap().contains("noun@2"), "{body}");

    // a view that doesn't compile
    d.write(&s, WORD, "export default function View( {").await;
    assert_eq!(d.publish(&s).await.0, StatusCode::UNPROCESSABLE_ENTITY);

    // an npm import without a pinned version
    d.write(&s, WORD, "import confetti from 'canvas-confetti';\nexport default function View() { return <p>{String(confetti)}</p>; }\n").await;
    let (status, body) = d.publish(&s).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body.to_string().contains("exact version"), "{body}");

    // guessed links are 404s, and many of them slow down
    for _ in 0..130 {
        s.lessons("/l/AAAAAAAAAAAAAAAAAAAAAA/current").await;
    }
    assert_eq!(s.lessons("/l/AAAAAAAAAAAAAAAAAAAAAA/current").await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(s.lessons("/lessons/../teacher.db").await.0, StatusCode::NOT_FOUND);
}
