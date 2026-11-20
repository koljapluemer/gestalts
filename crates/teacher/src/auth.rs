//! Signing in: accounts an admin makes (`gestalts-teacher admin`), a password, and a session cookie. The account table
//! has room for an OIDC subject, so school logins can take the password's place later.

use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Account;
use crate::{ApiError, ApiResult, AppState, now_iso, now_ms, random_token};

pub const COOKIE: &str = "gestalts_teacher";
const SESSION_DAYS: i64 = 30;
/// After this many failed sign-ins for one email, it waits.
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(15 * 60);

pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("the OS has randomness");
    let salt = SaltString::encode_b64(&salt).expect("16 bytes make a salt");
    Argon2::default().hash_password(password.as_bytes(), &salt).expect("argon2 hashes any password").to_string()
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(COOKIE)?.strip_prefix('='))
}

/// The signed-in teacher, or 401.
pub struct Teacher(pub Account);

impl FromRequestParts<AppState> for Teacher {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = session_token(&parts.headers).ok_or(ApiError::Unauthorized)?;
        state.db.session(&token_hash(token), &now_iso())?.map(Teacher).ok_or(ApiError::Unauthorized)
    }
}

fn cookie(state: &AppState, value: &str, max_age: i64) -> HeaderValue {
    let secure = if state.secure_cookies { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")).expect("a cookie of base64url is a header value")
}

#[derive(Deserialize)]
struct Login {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct Me {
    pub email: String,
    pub school: String,
}

async fn login(State(state): State<AppState>, Json(req): Json<Login>) -> ApiResult<Response> {
    let email = req.email.trim().to_lowercase();
    {
        let mut failures = state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        failures.retain(|_, (_, since)| since.elapsed() < LOCKOUT);
        if failures.get(&email).is_some_and(|(n, _)| *n >= MAX_FAILURES) {
            return Err(ApiError::TooMany("too many failed sign-ins: try again in 15 minutes".into()));
        }
    }
    let found = state.db.account_by_email(&email)?;
    // a hash is checked either way, so an unknown email takes as long as a wrong password
    let hash = found.as_ref().and_then(|(_, h)| h.clone()).unwrap_or_else(|| DUMMY.with(Clone::clone));
    let ok = verify_password(&req.password, &hash) && found.as_ref().is_some_and(|(_, h)| h.is_some());
    let Some((account, _)) = found.filter(|_| ok) else {
        let mut failures = state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = failures.entry(email).or_insert((0, Instant::now()));
        entry.0 += 1;
        return Err(ApiError::Unauthorized);
    };
    state.failures.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&email);
    let token = random_token(32);
    let expires = gestalts_core::iso_datetime(now_ms() + SESSION_DAYS * 86_400_000);
    state.db.add_session(&token_hash(&token), &account.id, &expires)?;
    let mut res = Json(Me { email: account.email, school: account.school }).into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie(&state, &token, SESSION_DAYS * 86_400));
    Ok(res)
}

thread_local! {
    static DUMMY: String = hash_password("not anyone's password");
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(t) = session_token(&headers) {
        state.db.drop_session(&token_hash(t))?;
    }
    let mut res = axum::http::StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie(&state, "", 0));
    Ok(res)
}

async fn me(Teacher(a): Teacher) -> Json<Me> {
    Json(Me { email: a.email, school: a.school })
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/login", post(login)).route("/logout", post(logout)).route("/me", get(me))
}
