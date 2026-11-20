//! A server on a temporary folder, with two teachers at one school, called as the browser calls it.
#![allow(dead_code)]

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use gestalts_teacher::agent::Model;
use gestalts_teacher::worker::WorkerConfig;
use gestalts_teacher::{AppState, Limits, Services, auth, db::Db};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

pub struct Server {
    pub state: AppState,
    _dir: tempfile::TempDir,
}

/// The repo's own worker and agent template; a model at `model` (none: the agent is off).
pub fn services(model: Option<String>, cache: &std::path::Path) -> Services {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    Services {
        worker: WorkerConfig { node: "node".into(), script: repo.join("apps/teacher/worker/worker.ts"), template: repo.join("packages/workshop/agent-template"), npm_cache: cache.to_owned() },
        model: Model { api_key: model.as_ref().map(|_| "test-key".into()), base_url: model.unwrap_or_default(), model: "claude-opus-5-5".into() },
    }
}

impl Server {
    pub fn new(limits: Limits) -> Self {
        Self::with_model(limits, None)
    }

    pub fn with_model(limits: Limits, model: Option<String>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::memory().unwrap();
        db.add_school("s1", "A school", "2026-11-20T00:00:00Z").unwrap();
        for (id, email) in [("a1", "ada@school.example"), ("a2", "bea@school.example")] {
            db.add_account(id, "s1", email, &auth::hash_password("right"), 1_000_000, "2026-11-20T00:00:00Z").unwrap();
        }
        let state = AppState::new(db, dir.path().to_owned(), limits, true, services(model, &dir.path().join("npm-cache"))).unwrap();
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

