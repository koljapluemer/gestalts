//! One HTTP request at a time: `fetch` in the browser, reqwest natively.

use gestalts_core::storage::{Result, StorageError};
use serde::Deserialize;

/// `s` as `encodeURIComponent` encodes it.
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn status_error(method: &str, url: &str, status: u16, text: &str) -> StorageError {
    StorageError::Io(format!("{method} {url}: {status} {text}"))
}

pub async fn json<T: for<'de> Deserialize<'de>>(resp: Body) -> Result<T> {
    serde_json::from_str(&resp.text().await?).map_err(|e| StorageError::Io(e.to_string()))
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;
    use js_sys::Uint8Array;
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{Request, RequestInit, Response};

    fn js_err(e: JsValue) -> StorageError {
        StorageError::Io(
            e.dyn_ref::<js_sys::Error>().map(|e| String::from(e.message())).or_else(|| e.as_string()).unwrap_or_else(|| format!("{e:?}")),
        )
    }

    pub struct Body(Response);

    impl Body {
        pub async fn text(self) -> Result<String> {
            Ok(JsFuture::from(self.0.text().map_err(js_err)?).await.map_err(js_err)?.as_string().unwrap_or_default())
        }
        pub async fn bytes(self) -> Result<Vec<u8>> {
            let buf = JsFuture::from(self.0.array_buffer().map_err(js_err)?).await.map_err(js_err)?;
            Ok(Uint8Array::new(&buf).to_vec())
        }
    }

    /// `Ok(None)` on 404.
    pub async fn fetch(url: &str, method: &str, body: Option<&[u8]>) -> Result<Option<Body>> {
        let init = RequestInit::new();
        init.set_method(method);
        if let Some(b) = body {
            init.set_body(&Uint8Array::from(b).into());
        }
        let req = Request::new_with_str_and_init(url, &init).map_err(js_err)?;
        let window = web_sys::window().ok_or_else(|| StorageError::Io("no window".into()))?;
        let resp: Response = JsFuture::from(window.fetch_with_request(&req))
            .await
            .map_err(|e| StorageError::Io(format!("{method} {url}: {}", js_err(e))))?
            .unchecked_into();
        match resp.status() {
            404 => Ok(None),
            s if (200..300).contains(&s) => Ok(Some(Body(resp))),
            s => {
                let text = Body(resp).text().await.unwrap_or_default();
                Err(status_error(method, url, s, &text))
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::*;
    use std::sync::OnceLock;

    fn io(e: reqwest::Error) -> StorageError {
        StorageError::Io(e.to_string())
    }

    pub struct Body(reqwest::Response);

    impl Body {
        pub async fn text(self) -> Result<String> {
            self.0.text().await.map_err(io)
        }
        pub async fn bytes(self) -> Result<Vec<u8>> {
            Ok(self.0.bytes().await.map_err(io)?.to_vec())
        }
    }

    fn client() -> &'static reqwest::Client {
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        CLIENT.get_or_init(reqwest::Client::new)
    }

    /// `Ok(None)` on 404.
    pub async fn fetch(url: &str, method: &str, body: Option<&[u8]>) -> Result<Option<Body>> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| StorageError::Io(e.to_string()))?;
        let mut req = client().request(m, url);
        if let Some(b) = body {
            req = req.body(b.to_vec());
        }
        let resp = req.send().await.map_err(|e| StorageError::Io(format!("{method} {url}: {e}")))?;
        match resp.status().as_u16() {
            404 => Ok(None),
            s if (200..300).contains(&s) => Ok(Some(Body(resp))),
            s => {
                let text = resp.text().await.unwrap_or_default();
                Err(status_error(method, url, s, &text))
            }
        }
    }
}

pub use imp::{Body, fetch};

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(super::enc("a b/c?d#é~'()*!"), "a%20b%2Fc%3Fd%23%C3%A9~'()*!");
    }
}
