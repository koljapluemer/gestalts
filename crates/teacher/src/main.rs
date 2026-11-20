//! `gestalts-teacher serve` runs the teacher app's server; `gestalts-teacher admin …` makes schools and accounts.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use gestalts_teacher::agent::{MODEL, Model};
use gestalts_teacher::worker::WorkerConfig;
use gestalts_teacher::{AppState, Limits, Services, auth, db, now_iso, random_hex, random_token};

#[derive(Parser)]
#[command(about = "The teacher app's server")]
struct Cli {
    /// where everything lives: teacher.db, drafts/, lessons/, npm/, runtime/
    #[arg(long, env = "TEACHER_DATA", default_value = "teacher-data")]
    data: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serves the app's API and the lesson domain
    Serve {
        /// the app's API (`/api`), behind the app's domain
        #[arg(long, default_value = "127.0.0.1:7740")]
        app: SocketAddr,
        /// the lesson domain: the player, lessons and npm bundles
        #[arg(long, default_value = "127.0.0.1:7741")]
        lessons: SocketAddr,
        /// cookies without `Secure`, for a local run over http
        #[arg(long)]
        insecure_cookies: bool,
        /// the repo checkout: the worker (apps/teacher/worker) and the agent template (packages/workshop) are in it
        #[arg(long, env = "TEACHER_REPO", default_value = ".")]
        repo: PathBuf,
        #[arg(long, env = "TEACHER_NODE", default_value = "node")]
        node: String,
        /// the agent's model
        #[arg(long, default_value = MODEL)]
        model: String,
        /// the lesson domain as students reach it, for links
        #[arg(long, env = "TEACHER_LESSON_ORIGIN", default_value = "http://127.0.0.1:7741")]
        lesson_origin: String,
    },
    /// Schools and accounts
    Admin {
        #[command(subcommand)]
        command: Admin,
    },
}

#[derive(Subcommand)]
enum Admin {
    /// A school; prints its id
    AddSchool { name: String },
    /// A teacher at a school; prints a password to hand over
    AddTeacher {
        #[arg(long)]
        school: String,
        #[arg(long)]
        email: String,
    },
    /// A new password for a teacher, signing them out everywhere; prints it
    ResetPassword {
        #[arg(long)]
        email: String,
    },
    /// A player build (apps/player/dist) under runtime/<its version>/, for the lessons made against it; prints the version
    InstallPlayer {
        #[arg(long, default_value = "apps/player/dist")]
        dist: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    if let Err(e) = run(Cli::parse()).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    std::fs::create_dir_all(&cli.data).map_err(|e| format!("{}: {e}", cli.data.display()))?;
    let db = db::Db::open(&cli.data.join("teacher.db")).map_err(|e| e.to_string())?;
    let limits = Limits::default();
    match cli.command {
        Command::Admin { command } => {
            let now = now_iso();
            match command {
                Admin::AddSchool { name } => {
                    let id = random_hex(8);
                    db.add_school(&id, &name, &now).map_err(|e| e.to_string())?;
                    println!("{id}");
                }
                Admin::AddTeacher { school, email } => {
                    if !db.school_exists(&school).map_err(|e| e.to_string())? {
                        return Err(format!("no school {school}"));
                    }
                    let password = random_token(12);
                    let email = email.trim().to_lowercase();
                    db.add_account(&random_hex(8), &school, &email, &auth::hash_password(&password), limits.token_budget, &now).map_err(|e| e.to_string())?;
                    println!("{password}");
                }
                Admin::InstallPlayer { dist } => {
                    let meta = std::fs::read_to_string(dist.join("gestalts-runtime.json")).map_err(|e| format!("{}: {e}: build the player first", dist.display()))?;
                    let version = serde_json::from_str::<serde_json::Value>(&meta).ok().and_then(|v| v["version"].as_str().map(str::to_owned)).ok_or("gestalts-runtime.json has no version")?;
                    let to = cli.data.join("runtime").join(&version);
                    copy_dir(&dist, &to).map_err(|e| format!("{}: {e}", to.display()))?;
                    println!("{version}");
                }
                Admin::ResetPassword { email } => {
                    let password = random_token(12);
                    if !db.set_password(&email.trim().to_lowercase(), &auth::hash_password(&password)).map_err(|e| e.to_string())? {
                        return Err(format!("no account {email}"));
                    }
                    println!("{password}");
                }
            }
            Ok(())
        }
        Command::Serve { app, lessons, insecure_cookies, repo, node, model, lesson_origin } => {
            let repo = std::fs::canonicalize(&repo).map_err(|e| format!("{}: {e}", repo.display()))?;
            let services = Services {
                worker: WorkerConfig {
                    node,
                    script: repo.join("apps/teacher/worker/worker.ts"),
                    template: repo.join("packages/workshop/agent-template"),
                    npm_cache: std::path::absolute(cli.data.join("npm-cache")).map_err(|e| e.to_string())?,
                },
                model: Model {
                    api_key: std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.is_empty()),
                    base_url: std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| "https://api.anthropic.com".into()),
                    model,
                },
                lesson_origin,
            };
            if services.model.api_key.is_none() {
                eprintln!("no ANTHROPIC_API_KEY: the agent is off");
            }
            let state = AppState::new(db, cli.data, limits, !insecure_cookies, services)?;
            let app_listener = tokio::net::TcpListener::bind(app).await.map_err(|e| format!("{app}: {e}"))?;
            let lesson_listener = tokio::net::TcpListener::bind(lessons).await.map_err(|e| format!("{lessons}: {e}"))?;
            eprintln!("app API on http://{app}/api, lessons on http://{lessons}");
            let a = axum::serve(app_listener, gestalts_teacher::app(state.clone()));
            let l = axum::serve(lesson_listener, gestalts_teacher::lessons(state));
            tokio::select! {
                r = a => r.map_err(|e| e.to_string()),
                r = l => r.map_err(|e| e.to_string()),
                _ = tokio::signal::ctrl_c() => Ok(()),
            }
        }
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()))?;
        } else {
            std::fs::copy(e.path(), to.join(e.file_name()))?;
        }
    }
    Ok(())
}
