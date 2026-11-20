//! The app's API over HTTP, as the browser uses it.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use gestalts_teacher::{AppState, Limits, auth, db::Db};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

pub struct Server {
    pub state: AppState,
    _dir: tempfile::TempDir,
}

impl Server {
    pub fn new(limits: Limits) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::memory().unwrap();
        db.add_school("s1", "A school", "2026-11-20T00:00:00Z").unwrap();
        for (id, email) in [("a1", "ada@school.example"), ("a2", "bea@school.example")] {
            db.add_account(id, "s1", email, &auth::hash_password("right"), 1000, "2026-11-20T00:00:00Z").unwrap();
        }
        let state = AppState::new(db, dir.path().to_owned(), limits, true).unwrap();
        Server { state, _dir: dir }
    }

    pub async fn call(&self, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> (StatusCode, Value, Option<String>) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())).unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        let res = gestalts_teacher::app(self.state.clone()).oneshot(req).await.unwrap();
        let status = res.status();
        let set_cookie = res.headers().get(header::SET_COOKIE).map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), set_cookie)
    }

    pub async fn login(&self, email: &str) -> String {
        let (status, _, cookie) = self.call("POST", "/api/login", None, Some(json!({ "email": email, "password": "right" }))).await;
        assert_eq!(status, StatusCode::OK);
        cookie.unwrap()
    }
}

#[tokio::test]
async fn signing_in_and_out() {
    let s = Server::new(Limits::default());
    assert_eq!(s.call("GET", "/api/me", None, None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(s.call("POST", "/api/login", None, Some(json!({ "email": "ada@school.example", "password": "wrong" }))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(s.call("POST", "/api/login", None, Some(json!({ "email": "nobody@x", "password": "right" }))).await.0, StatusCode::UNAUTHORIZED);
    let cookie = s.login(" Ada@School.example ").await;
    let (status, me, _) = s.call("GET", "/api/me", Some(&cookie), None).await;
    assert_eq!((status, me["email"].as_str()), (StatusCode::OK, Some("ada@school.example")));
    assert_eq!(s.call("POST", "/api/logout", Some(&cookie), None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.call("GET", "/api/me", Some(&cookie), None).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn too_many_wrong_passwords_wait() {
    let s = Server::new(Limits::default());
    for _ in 0..5 {
        s.call("POST", "/api/login", None, Some(json!({ "email": "ada@school.example", "password": "wrong" }))).await;
    }
    let (status, _, _) = s.call("POST", "/api/login", None, Some(json!({ "email": "ada@school.example", "password": "right" }))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_draft_syncs_like_a_node_and_holds_only_what_is_valid() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let (status, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "der, die, das" }))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (id, package) = (d["id"].as_str().unwrap().to_owned(), d["package"].as_str().unwrap().to_owned());
    assert!(id.starts_with("der-die-das-") && package.starts_with("d-"), "{d}");
    let base = format!("/api/drafts/{id}");

    let (_, health, _) = s.call("GET", &format!("{base}/health"), Some(&ada), None).await;
    assert_eq!((health["api"].as_u64(), health["folder"]["id"].as_str()), (Some(3), Some(id.as_str())));

    let view = format!("id: {id}\ngestalt: view@2\ntitle: Artikel\nsource: x\nreads: []\nwrites: []\npackage: {package}\n");
    let noun = format!("id: gestalt-{package}.noun.1\ngestalt: gestalt@1\nname: {package}/noun\nversion: 1\nfields:\n  word: {{ type: string, required: true }}\n");
    let write = json!([{ "id": id, "text": view }, { "id": format!("gestalt-{package}.noun.1"), "text": noun }, { "id": "haus", "text": format!("id: haus\ngestalt: {package}/noun@1\nword: Haus\n") }]);
    assert_eq!(s.call("POST", &format!("{base}/sync/write"), Some(&ada), Some(write)).await.0, StatusCode::NO_CONTENT);

    let (_, hashes, _) = s.call("GET", &format!("{base}/sync/hashes"), Some(&ada), None).await;
    assert_eq!(hashes.as_object().unwrap().len(), 3);
    let (_, read, _) = s.call("POST", &format!("{base}/sync/read"), Some(&ada), Some(json!({ "ids": ["haus", "nope"] }))).await;
    assert_eq!(read.as_array().unwrap().len(), 1);
    let (_, list, _) = s.call("GET", "/api/drafts", Some(&ada), None).await;
    assert_eq!(list[0]["title"].as_str(), Some("Artikel"), "the view's title shows in the list");

    // a write with anything wrong in it lands not at all
    let bad = json!([{ "id": "baum", "text": format!("id: baum\ngestalt: {package}/noun@1\nword: Baum\n") }, { "id": "x", "text": "id: x\ngestalt: d-000000000000/noun@1\nword: x\n" }]);
    let (status, body, _) = s.call("POST", &format!("{base}/sync/write"), Some(&ada), Some(bad)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["problems"][0].as_str().unwrap().contains("no gestalt d-000000000000/noun@1"), "{body}");
    let (_, hashes, _) = s.call("GET", &format!("{base}/sync/hashes"), Some(&ada), None).await;
    assert!(hashes.get("baum").is_none());
}

#[tokio::test]
async fn a_draft_is_only_its_owners() {
    let s = Server::new(Limits::default());
    let ada = s.login("ada@school.example").await;
    let bea = s.login("bea@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Mine" }))).await;
    let id = d["id"].as_str().unwrap();
    for (m, p, b) in [("GET", "health", None), ("GET", "sync/hashes", None), ("POST", "sync/read", Some(json!({ "ids": [] }))), ("POST", "sync/write", Some(json!([]))), ("GET", "blobs", None)] {
        assert_eq!(s.call(m, &format!("/api/drafts/{id}/{p}"), Some(&bea), b).await.0, StatusCode::NOT_FOUND, "{p}");
    }
    assert_eq!(s.call("DELETE", &format!("/api/drafts/{id}"), Some(&bea), None).await.0, StatusCode::NOT_FOUND);
    assert!(s.call("GET", "/api/drafts", Some(&bea), None).await.1.as_array().unwrap().is_empty());
    assert_eq!(s.call("GET", "/api/drafts/..%2F..%2Fetc/health", Some(&ada), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.call("DELETE", &format!("/api/drafts/{id}"), Some(&ada), None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.call("GET", &format!("/api/drafts/{id}/health"), Some(&ada), None).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn quotas_hold() {
    let s = Server::new(Limits { drafts_per_account: 1, ymls_per_draft: 2, blob_bytes: 10, account_blob_bytes: 15, ..Limits::default() });
    let ada = s.login("ada@school.example").await;
    let (_, d, _) = s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "One" }))).await;
    assert_eq!(s.call("POST", "/api/drafts", Some(&ada), Some(json!({ "title": "Two" }))).await.0, StatusCode::TOO_MANY_REQUESTS);
    let base = format!("/api/drafts/{}", d["id"].as_str().unwrap());
    let notes = |ids: &[&str]| json!(ids.iter().map(|i| json!({ "id": i, "text": format!("id: {i}\ngestalt: note@1\n") })).collect::<Vec<_>>());
    assert_eq!(s.call("POST", &format!("{base}/sync/write"), Some(&ada), Some(notes(&["a", "b"]))).await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.call("POST", &format!("{base}/sync/write"), Some(&ada), Some(notes(&["c"]))).await.0, StatusCode::UNPROCESSABLE_ENTITY);

    let put = |name: &str, n: usize| {
        let req = Request::builder().method("PUT").uri(format!("{base}/blobs/{name}")).header(header::COOKIE, &ada).body(Body::from(vec![1u8; n])).unwrap();
        gestalts_teacher::app(s.state.clone()).oneshot(req)
    };
    assert_eq!(put("a.png", 11).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(put("a.png", 10).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(put("b.png", 10).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE, "over the account's total");
}
