//! A turn of the agent against a stand-in for the Messages API, which answers from a script and keeps what it was sent.

mod common;

use std::sync::{Arc, Mutex};

use common::Server;
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use gestalts_teacher::Limits;
use serde_json::{Value, json};

type Seen = Arc<Mutex<Vec<(HeaderMap, Value)>>>;

/// A Messages API that answers each request with the next of `script`.
async fn model(script: Vec<Value>) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let script = Arc::new(Mutex::new(script.into_iter()));
    let s = seen.clone();
    let app = axum::Router::new().route(
        "/v1/messages",
        axum::routing::post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let (seen, script) = (s.clone(), script.clone());
            async move {
                seen.lock().unwrap().push((headers, body));
                match script.lock().unwrap().next() {
                    Some(r) => (StatusCode::OK, Json(r)),
                    None => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": { "message": "script ran out" } }))),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

fn reply(content: Value, stop: &str) -> Value {
    json!({ "id": "msg", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": content, "stop_reason": stop,
            "usage": { "input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 0 } })
}

const VIEW: &str = "export default function View() {\n  return <div className=\"h-full\">Hallo</div>;\n}\n";

async fn events(s: &Server, cookie: &str, base: &str, job: &str) -> Vec<Value> {
    let mut all = Vec::new();
    loop {
        let (status, page, _) = s.call("GET", &format!("{base}/agent/events?job={job}&after={}", all.len()), Some(cookie), None).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        all.extend(page["events"].as_array().unwrap().iter().cloned());
        if page["done"] == true {
            return all;
        }
    }
}

#[tokio::test]
async fn a_turn_edits_the_files_checks_them_and_hands_them_back() {
    let (url, seen) = model(vec![
        reply(json!([{ "type": "text", "text": "Ich mache das." }, { "type": "tool_use", "id": "t1", "name": "write_file", "input": { "path": "view.tsx", "content": VIEW } }]), "tool_use"),
        reply(json!([{ "type": "tool_use", "id": "t2", "name": "check", "input": {} }, { "type": "tool_use", "id": "t3", "name": "write_file", "input": { "path": "../escape.ts", "content": "x" } }]), "tool_use"),
        reply(json!([{ "type": "text", "text": "Fertig." }]), "end_turn"),
        reply(json!([{ "type": "text", "text": "Noch da." }]), "end_turn"),
    ]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Hallo" }))).await;
    let (id, package) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    let base = format!("/api/drafts/{id}");
    assert_eq!(s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await.1["available"], true);

    let files = json!({ "view.tsx": "export default function View() { return null; }\n", "view.json": format!("{{\"title\":\"Hallo\",\"package\":\"{package}\",\"reads\":[],\"writes\":[],\"npm\":{{}}}}") });
    let turn = json!({ "view": id, "message": "Sag Hallo.", "files": files, "gestalts": ["note@1"], "diagnostics": [{ "kind": "render", "message": "boom", "at": "x" }] });
    let (status, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(turn.clone())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let all = events(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    let kinds: Vec<&str> = all.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["text", "tool", "tool", "tool", "text", "files", "done"], "{all:?}");
    assert_eq!(all[5]["files"], json!({ "view.tsx": VIEW }));
    let session = all[6]["session"].as_str().unwrap().to_owned();

    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 3);
    let (headers, first) = &sent[0];
    assert_eq!(headers["anthropic-version"], "2026-10-21");
    assert_eq!(headers["x-api-key"], "test-key");
    assert_eq!(first["model"], "claude-opus-5-5");
    assert_eq!(first["output_config"]["effort"], "high");
    assert_eq!(first["fallbacks"], "default");
    assert!(first.get("thinking").is_none());
    assert_eq!(first["system"][0]["cache_control"]["type"], "ephemeral");
    assert!(first["system"][0]["text"].as_str().unwrap().contains("There is no shell"));
    let opening = first["messages"][0]["content"][0]["text"].as_str().unwrap();
    assert!(opening.starts_with("Sag Hallo.") && opening.contains("boom"), "{opening}");
    // the check ran for real, and the escape was refused
    let results = &sent[2].1["messages"][4]["content"];
    assert_eq!(results[0]["is_error"], false, "{results}");
    assert!(results[0]["content"].as_str().unwrap().contains("all good"), "{results}");
    assert_eq!(results[1]["is_error"], true);

    // the next turn goes on in the same conversation, told what changed since (the browser saved the new view.tsx,
    // so nothing did)
    let mut next = turn.clone();
    next["session"] = json!(session);
    next["message"] = json!("Noch etwas.");
    next["diagnostics"] = json!([]);
    next["files"]["view.tsx"] = json!(VIEW);
    next["files"]["view.json"] = json!(files["view.json"]);
    let (status, started, _) = s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(next)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{started}");
    let all = events(&s, &ada, &base, started["job"].as_str().unwrap()).await;
    assert_eq!(all.iter().map(|e| e["type"].as_str().unwrap()).collect::<Vec<_>>(), ["text", "done"]);
    let fourth = seen.lock().unwrap()[3].1.clone();
    let messages = fourth["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 7, "the first turn's six, and this one");
    assert_eq!(messages[6]["content"][0]["text"], "Noch etwas.");

    // what it used counts against the month's budget
    assert!(s.state.db.tokens_since("a1", "2026-01-01T00:00:00.000Z").unwrap() > 0);
}

#[tokio::test]
async fn a_turn_needs_a_budget_left_and_waits_for_the_last_one() {
    let (url, _) = model(vec![]).await;
    let s = Server::with_model(Limits::default(), Some(url));
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "x" }))).await;
    let base = format!("/api/drafts/{}", d["id"].as_str().unwrap());
    // a1's budget is a million tokens: one turn of two million uses it up
    s.state.db.add_turn("t0", "a1", "x", &gestalts_teacher::now_iso()).unwrap();
    s.state.db.add_usage("t0", 2_000_000, 0, 0, 0).unwrap();
    let turn = json!({ "view": d["id"], "message": "hi", "files": {}, "gestalts": [] });
    assert_eq!(s.call("POST", &format!("{base}/agent/turn"), Some(&ada), Some(turn)).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(s.call("GET", &format!("{base}/agent/status"), Some(&ada), None).await.1["available"], false);
}

#[tokio::test]
async fn without_a_key_the_agent_is_off_and_says_so() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "x" }))).await;
    let (_, st, _) = s.call("GET", &format!("/api/drafts/{}/agent/status", d["id"].as_str().unwrap()), Some(&ada), None).await;
    assert_eq!(st["available"], false);
    assert!(st["reason"].as_str().unwrap().contains("API key"));
}
