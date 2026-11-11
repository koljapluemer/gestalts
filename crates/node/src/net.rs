//! `/net`: HTTP on behalf of a view, to hosts some plugin declared in its manifest's `network`. The app's bridge checks
//! the view's own list before a request gets here; this checks the union, so the route is never an open proxy.
//!
//! The request rides in headers (`x-gestalts-url`, `x-gestalts-method`) with the body as is; the answer is the remote's
//! status, `content-type` and body, marked `x-gestalts-upstream: 1` so the app can tell it from the node's own refusals.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

pub const URL_HEADER: &str = "x-gestalts-url";
pub const METHOD_HEADER: &str = "x-gestalts-method";
pub const UPSTREAM_HEADER: &str = "x-gestalts-upstream";

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;
/// enough for a subtitle track or an API answer; this isn't for media
const MAX_BODY: usize = 20 * 1024 * 1024;
/// what a view may set; nothing that identifies the user (cookies, authorization) passes
const FORWARDED: [header::HeaderName; 3] = [header::CONTENT_TYPE, header::ACCEPT, header::ACCEPT_LANGUAGE];

#[derive(Clone)]
pub struct Net {
    hosts: Arc<BTreeSet<String>>,
    client: reqwest::Client,
}

/// `url` if it's https to one of `hosts`, on the default port.
pub fn allowed(url: &reqwest::Url, hosts: &BTreeSet<String>) -> bool {
    url.scheme() == "https" && url.port().is_none() && url.host_str().is_some_and(|h| hosts.contains(h)) && url.username().is_empty() && url.password().is_none()
}

impl Net {
    pub fn new(hosts: BTreeSet<String>) -> Self {
        let hosts = Arc::new(hosts);
        let policy_hosts = hosts.clone();
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            // each hop must be allowed too, or a redirect would lead anywhere
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS { attempt.error("too many redirects") }
                else if allowed(attempt.url(), &policy_hosts) { attempt.follow() }
                else { attempt.stop() }
            }))
            .build()
            .expect("the HTTP client builds");
        Net { hosts, client }
    }

    pub fn hosts(&self) -> &BTreeSet<String> { &self.hosts }

    pub async fn handle(&self, headers: &HeaderMap, body: Bytes) -> Response {
        let Some(url) = headers.get(URL_HEADER).and_then(|v| v.to_str().ok()).and_then(|u| reqwest::Url::parse(u).ok()) else {
            return (StatusCode::BAD_REQUEST, format!("{URL_HEADER} must hold an absolute URL")).into_response();
        };
        if !allowed(&url, &self.hosts) {
            return (StatusCode::FORBIDDEN, format!("no plugin here declares that it reaches {}", url.host_str().unwrap_or("that host"))).into_response();
        }
        let method = headers.get(METHOD_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("GET");
        let Ok(method) = reqwest::Method::from_bytes(method.as_bytes()) else { return (StatusCode::BAD_REQUEST, "bad method").into_response() };
        let mut request = self.client.request(method, url);
        for name in FORWARDED {
            if let Some(value) = headers.get(&name) { request = request.header(name, value); }
        }
        if !body.is_empty() { request = request.body(body); }
        let mut r = match request.send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => return (StatusCode::GATEWAY_TIMEOUT, format!("no answer within {}s", TIMEOUT.as_secs())).into_response(),
            Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
        };
        if r.content_length().is_some_and(|n| n as usize > MAX_BODY) { return (StatusCode::BAD_GATEWAY, "the answer is too large").into_response(); }
        let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let content_type = r.headers().get(header::CONTENT_TYPE).cloned();
        let mut out = Vec::new();
        loop {
            match r.chunk().await {
                Ok(Some(chunk)) => {
                    if out.len() + chunk.len() > MAX_BODY { return (StatusCode::BAD_GATEWAY, "the answer is too large").into_response(); }
                    out.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
            }
        }
        let mut response = (status, out).into_response();
        let h = response.headers_mut();
        h.insert(UPSTREAM_HEADER, HeaderValue::from_static("1"));
        if let Some(value) = content_type { h.insert(header::CONTENT_TYPE, value); }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> BTreeSet<String> { ["www.youtube.com".to_owned()].into() }
    fn url(u: &str) -> reqwest::Url { reqwest::Url::parse(u).unwrap() }

    #[test]
    fn only_https_to_declared_hosts() {
        assert!(allowed(&url("https://www.youtube.com/api/timedtext?v=x"), &hosts()));
        assert!(!allowed(&url("http://www.youtube.com/"), &hosts()));
        assert!(!allowed(&url("https://youtube.com/"), &hosts()));
        assert!(!allowed(&url("https://www.youtube.com.evil.example/"), &hosts()));
        assert!(!allowed(&url("https://www.youtube.com:8443/"), &hosts()));
        assert!(!allowed(&url("https://user@www.youtube.com/"), &hosts()));
        assert!(!allowed(&url("https://127.0.0.1/"), &hosts()));
    }

    #[tokio::test]
    async fn refuses_undeclared_hosts_without_a_request() {
        let net = Net::new(hosts());
        let mut headers = HeaderMap::new();
        headers.insert(URL_HEADER, HeaderValue::from_static("https://example.com/"));
        let r = net.handle(&headers, Bytes::new()).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        assert!(r.headers().get(UPSTREAM_HEADER).is_none());
    }
}
