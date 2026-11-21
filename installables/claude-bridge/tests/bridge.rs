#![cfg(unix)]
//! The bridge end to end, with a fake `claude` (Python) that edits a file and calls the page's tool through the MCP
//! shim the bridge configured: start → tool_call → tool_result → files → done.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("9.9.9 (Fake Claude)"); sys.exit(0)
cfg = json.load(open(args[args.index("--mcp-config") + 1]))["mcpServers"]["gestalts"]
prompt = sys.stdin.read()
def out(o): print(json.dumps(o), flush=True)
out({"type": "system", "subtype": "init", "session_id": "fake-session"})
open("view.tsx", "w").write("new")
os.remove("data/gone.yml")
p = subprocess.Popen([cfg["command"], *cfg["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**os.environ, **cfg["env"]}, text=True)
def rpc(i, method, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    return json.loads(p.stdout.readline())
rpc(1, "initialize", {"protocolVersion": "2025-06-18"})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
tools = rpc(2, "tools/list", {})["result"]["tools"]
out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "mcp__gestalts__" + tools[0]["name"], "input": {}}]}})
r = rpc(3, "tools/call", {"name": tools[0]["name"], "arguments": {"strict": True}})["result"]
allowed = args[args.index("--allowedTools") + 1:]
out({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps({"tool": r, "prompt": prompt, "allowed": allowed})}]}})
p.stdin.close(); p.wait()
out({"type": "result", "session_id": "fake-session", "is_error": False, "result": "ok", "num_turns": 1})
"#;

struct Bridge {
    child: std::process::Child,
    port: u16,
    _dir: tempfile::TempDir,
}

impl Drop for Bridge {
    fn drop(&mut self) { let _ = self.child.kill(); }
}

fn free_port() -> u16 { std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() }

async fn bridge() -> Bridge {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("claude");
    std::fs::write(&claude, FAKE_CLAUDE).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&claude, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let port = free_port();
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_gestalts-claude-bridge"))
        .args(["serve", "--dev", "--port", &port.to_string(), "--profile", "test"])
        .env("GESTALTS_CLAUDE", &claude).env("XDG_CONFIG_HOME", dir.path().join("config")).env("XDG_DATA_HOME", dir.path().join("data"))
        .env("HOME", dir.path()).stdout(std::process::Stdio::null()).spawn().unwrap();
    let b = Bridge { child, port, _dir: dir };
    for _ in 0..100 {
        if reqwest::get(format!("http://127.0.0.1:{port}/status")).await.is_ok() { return b; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the bridge didn't start");
}

async fn connect(port: u16, origin: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let mut req = format!("ws://127.0.0.1:{port}/runs").into_client_request().unwrap();
    req.headers_mut().insert("Origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

#[tokio::test]
async fn a_turn_with_a_tool_call() {
    let b = bridge().await;
    let status: Value = reqwest::Client::new().get(format!("http://127.0.0.1:{}/status", b.port)).header("Origin", "http://localhost:5173")
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(status["app"], "gestalts-claude-bridge");
    assert_eq!(status["paired"], true);
    assert_eq!(status["claude"]["version"], "9.9.9 (Fake Claude)");

    let mut ws = connect(b.port, "http://localhost:5173").await.unwrap();
    let start = json!({ "type": "start", "workspace": "d1", "prompt": "make it", "keep": r"view\.tsx|data/[^/]+\.yml",
        "files": { "view.tsx": "old", "data/gone.yml": "x", "CLAUDE.md": "the contract" },
        "tools": [{ "name": "check", "description": "checks", "inputSchema": { "type": "object" } }] });
    ws.send(Message::Text(start.to_string().into())).await.unwrap();
    let mut seen = vec![];
    let mut text = Value::Null;
    while let Some(Ok(msg)) = tokio::time::timeout(Duration::from_secs(20), ws.next()).await.expect("the bridge answers") {
        let Message::Text(t) = msg else { continue };
        let ev: Value = serde_json::from_str(&t).unwrap();
        seen.push(ev["type"].as_str().unwrap().to_owned());
        match ev["type"].as_str().unwrap() {
            "tool_call" => {
                assert_eq!(ev["name"], "check");
                assert_eq!(ev["input"], json!({ "strict": true }));
                // the draft as it is now: claude's edit in, the deleted file gone, the template not part of it
                assert_eq!(ev["files"], json!({ "view.tsx": "new" }));
                let reply = json!({ "type": "tool_result", "id": ev["id"], "content": [{ "type": "text", "text": "all good" }] });
                ws.send(Message::Text(reply.to_string().into())).await.unwrap();
            }
            "text" => text = serde_json::from_str(ev["text"].as_str().unwrap()).unwrap(),
            "files" => assert_eq!(ev["files"], json!({ "view.tsx": "new", "data/gone.yml": null })),
            "done" => { assert_eq!(ev["session"], "fake-session"); break; }
            "error" => panic!("{ev}"),
            _ => {}
        }
    }
    assert_eq!(seen, ["tool", "tool_call", "text", "files", "done"]);
    assert_eq!(text["tool"]["content"][0]["text"], "all good");
    assert_eq!(text["prompt"], "make it");
    assert!(text["allowed"].as_array().unwrap().contains(&json!("mcp__gestalts__check")));
}

#[tokio::test]
async fn only_allowed_sites() {
    let b = bridge().await;
    assert!(connect(b.port, "https://evil.example").await.is_err());
    let status: Value = reqwest::Client::new().get(format!("http://127.0.0.1:{}/status", b.port)).header("Origin", "https://evil.example")
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(status["paired"], false);
    // the shim's door is closed to browsers, and to anyone without the turn's secret
    let r = reqwest::Client::new().post(format!("http://127.0.0.1:{}/internal/runs/x/calls", b.port)).json(&json!({ "name": "check" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 404);
}
