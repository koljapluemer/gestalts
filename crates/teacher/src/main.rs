//! `gestalts-teacher serve` runs the teacher app's server; `gestalts-teacher admin …` makes schools and accounts.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use gestalts_teacher::{AppState, Limits, auth, db, now_iso, random_hex, random_token};

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
        Command::Serve { app, lessons, insecure_cookies } => {
            let state = AppState::new(db, cli.data, limits, !insecure_cookies)?;
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
