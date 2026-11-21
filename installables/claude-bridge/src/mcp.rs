//! `gestalts-claude-bridge mcp`: what claude starts as its `gestalts` MCP server during a turn. It speaks MCP over
//! stdio (JSON-RPC, one message per line) and hands each tool call to the bridge, which asks the page. The turn's
//! address and secret come in the environment, from the config the bridge wrote.

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

const PROTOCOL: &str = "2025-06-18";

pub fn run() -> Result<(), String> {
    let calls = std::env::var("GESTALTS_BRIDGE_CALLS").map_err(|_| "GESTALTS_BRIDGE_CALLS is not set: claude starts this")?;
    let secret = std::env::var("GESTALTS_BRIDGE_SECRET").map_err(|_| "GESTALTS_BRIDGE_SECRET is not set")?;
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(900)).build().map_err(|e| e.to_string())?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            reply(&mut stdout, json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }));
            continue;
        };
        // notifications get no answer
        let Some(id) = msg.get("id").cloned() else { continue };
        let result = handle(&http, &calls, &secret, msg.get("method").and_then(Value::as_str).unwrap_or(""), msg.get("params").unwrap_or(&Value::Null));
        reply(&mut stdout, match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        });
    }
    Ok(())
}

fn reply(out: &mut std::io::Stdout, v: Value) {
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn handle(http: &reqwest::blocking::Client, calls: &str, secret: &str, method: &str, params: &Value) -> Result<Value, (i32, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "gestalts", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => http.get(format!("{calls}/tools")).header("x-bridge-secret", secret).send()
            .and_then(|r| r.error_for_status()).and_then(|r| r.json::<Value>())
            .map_err(|e| (-32603, format!("the bridge: {e}"))),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).ok_or((-32602, "no tool name".into()))?;
            let body = json!({ "name": name, "arguments": params.get("arguments").cloned().unwrap_or(json!({})) });
            Ok(http.post(format!("{calls}/calls")).header("x-bridge-secret", secret).json(&body).send()
                .and_then(|r| r.error_for_status()).and_then(|r| r.json::<Value>())
                .unwrap_or_else(|e| crate::run::tool_error(format!("the bridge: {e}"))))
        }
        _ => Err((-32601, format!("no method {method}"))),
    }
}
