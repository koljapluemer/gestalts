//! The Node helper (`apps/teacher/worker/worker.ts`): compiling and checking views, bundling npm packages. One child,
//! started on first use and again if it dies, spoken to in JSON lines; calls run concurrently and are matched to
//! answers by id.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

/// How the worker is started.
#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub node: String,
    pub script: PathBuf,
    /// the agent template, with its node_modules
    pub template: PathBuf,
    pub npm_cache: PathBuf,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Running {
    stdin: ChildStdin,
    pending: Pending,
    _child: Child,
    alive: Arc<std::sync::atomic::AtomicBool>,
}

pub struct Worker {
    config: WorkerConfig,
    running: tokio::sync::Mutex<Option<Running>>,
    next: AtomicU64,
}

const CALL_TIMEOUT: Duration = Duration::from_secs(300);

impl Worker {
    pub fn new(config: WorkerConfig) -> Self {
        Worker { config, running: tokio::sync::Mutex::default(), next: AtomicU64::new(1) }
    }

    pub fn config(&self) -> &WorkerConfig {
        &self.config
    }

    fn spawn(&self) -> Result<Running, String> {
        let mut child = Command::new(&self.config.node)
            .arg(&self.config.script)
            .current_dir(self.config.script.parent().unwrap_or(std::path::Path::new(".")))
            .env("TEACHER_TEMPLATE", &self.config.template)
            .env("TEACHER_NPM_CACHE", &self.config.npm_cache)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("starting the worker ({}): {e}", self.config.script.display()))?;
        let stdin = child.stdin.take().ok_or("the worker has no stdin")?;
        let stdout = child.stdout.take().ok_or("the worker has no stdout")?;
        let pending: Pending = Arc::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (p, a) = (pending.clone(), alive.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = msg["id"].as_u64() else { continue };
                let answer = if msg["ok"].as_bool() == Some(true) { Ok(msg["result"].clone()) } else { Err(msg["error"].as_str().unwrap_or("the worker failed").to_owned()) };
                if let Some(tx) = p.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id) {
                    let _ = tx.send(answer);
                }
            }
            // gone: whoever waits hears so, and the next call starts another
            a.store(false, Ordering::SeqCst);
            for (_, tx) in p.lock().unwrap_or_else(std::sync::PoisonError::into_inner).drain() {
                let _ = tx.send(Err("the worker stopped".into()));
            }
        });
        Ok(Running { stdin, pending, _child: child, alive })
    }

    /// One operation (`check`, `compile`, `npm`) with its arguments; what it answered.
    pub async fn call(&self, op: &str, mut args: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        args["id"] = json!(id);
        args["op"] = json!(op);
        let (tx, rx) = oneshot::channel();
        {
            let mut running = self.running.lock().await;
            if running.as_ref().is_none_or(|r| !r.alive.load(Ordering::SeqCst)) {
                *running = Some(self.spawn()?);
            }
            let r = running.as_mut().expect("just started");
            r.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id, tx);
            let line = format!("{args}\n");
            if let Err(e) = r.stdin.write_all(line.as_bytes()).await {
                *running = None;
                return Err(format!("writing to the worker: {e}"));
            }
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("the worker stopped".into()),
            Err(_) => Err(format!("the worker took longer than {} s", CALL_TIMEOUT.as_secs())),
        }
    }

    /// `node check.ts` on a draft's files, with the npm check: whether it passed, and what it printed.
    pub async fn check(&self, files: &std::collections::BTreeMap<String, String>, gestalts: &[String]) -> Result<(bool, String), String> {
        let r = self.call("check", json!({ "files": files, "gestalts": gestalts })).await?;
        Ok((r["ok"].as_bool().unwrap_or(false), r["output"].as_str().unwrap_or_default().to_owned()))
    }
}
