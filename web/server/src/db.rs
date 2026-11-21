//! What isn't a teacher's own plain-text data: schools, accounts, sessions, drafts, publications and the agent's usage.
//! Every draft and publication has an owner and a school from the start, whether or not anything shows it yet.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};

pub use rusqlite::Error;

/// Each entry moves the schema one version on; `PRAGMA user_version` says how far a database is.
const MIGRATIONS: &[&str] = &[r"
    CREATE TABLE schools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created TEXT NOT NULL
    );
    CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        school TEXT NOT NULL REFERENCES schools(id),
        email TEXT NOT NULL UNIQUE,
        -- argon2; null for an account that only signs in through OIDC
        password TEXT,
        oidc_subject TEXT UNIQUE,
        -- the agent's tokens per calendar month
        token_budget INTEGER NOT NULL,
        created TEXT NOT NULL,
        disabled TEXT
    );
    CREATE TABLE sessions (
        -- sha256 of the cookie's token, so a leaked database signs nobody in
        token_hash TEXT PRIMARY KEY,
        account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires TEXT NOT NULL
    );
    CREATE TABLE drafts (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES accounts(id),
        school TEXT NOT NULL REFERENCES schools(id),
        -- what its own gestalts are named in; never another draft's
        package TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        created TEXT NOT NULL,
        deleted TEXT
    );
    CREATE TABLE publications (
        -- the lesson's id in its link: 128 random bits
        id TEXT PRIMARY KEY,
        draft TEXT NOT NULL REFERENCES drafts(id),
        owner TEXT NOT NULL REFERENCES accounts(id),
        school TEXT NOT NULL REFERENCES schools(id),
        -- the path of the current version's manifest on the lesson domain
        manifest TEXT NOT NULL,
        -- the structure hash of each gestalt it defines, by name@N, as JSON: published definitions never change
        definitions TEXT NOT NULL,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        revoked TEXT
    );
    CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL REFERENCES accounts(id),
        draft TEXT NOT NULL,
        started TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX turns_by_account ON turns(account, started);
"];

pub struct Db(Mutex<Connection>);

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub id: String,
    pub school: String,
    pub email: String,
    pub token_budget: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Draft {
    pub id: String,
    #[serde(skip)]
    pub owner: String,
    #[serde(skip)]
    pub school: String,
    pub package: String,
    pub title: String,
    pub created: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Publication {
    pub id: String,
    pub draft: String,
    #[serde(skip)]
    pub owner: String,
    pub manifest: String,
    #[serde(skip)]
    pub definitions: String,
    pub created: String,
    pub updated: String,
    pub revoked: Option<String>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, Error> {
        Self::migrate(Connection::open(path)?)
    }

    pub fn memory() -> Result<Self, Error> {
        Self::migrate(Connection::open_in_memory()?)
    }

    fn migrate(conn: Connection) -> Result<Self, Error> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let at: usize = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(at) {
            conn.execute_batch(&format!("BEGIN; {m}; PRAGMA user_version = {}; COMMIT;", i + 1))?;
        }
        Ok(Db(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // a panic mid-query leaves nothing half-done that SQLite didn't roll back
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn add_school(&self, id: &str, name: &str, now: &str) -> Result<(), Error> {
        self.conn().execute("INSERT INTO schools (id, name, created) VALUES (?1, ?2, ?3)", params![id, name, now]).map(drop)
    }

    pub fn school_exists(&self, id: &str) -> Result<bool, Error> {
        self.conn().query_row("SELECT 1 FROM schools WHERE id = ?1", [id], |_| Ok(())).optional().map(|r| r.is_some())
    }

    pub fn add_account(&self, id: &str, school: &str, email: &str, password_hash: &str, token_budget: i64, now: &str) -> Result<(), Error> {
        self.conn()
            .execute(
                "INSERT INTO accounts (id, school, email, password, token_budget, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, school, email, password_hash, token_budget, now],
            )
            .map(drop)
    }

    pub fn set_password(&self, email: &str, password_hash: &str) -> Result<bool, Error> {
        let conn = self.conn();
        let n = conn.execute("UPDATE accounts SET password = ?2 WHERE email = ?1", params![email, password_hash])?;
        // a new password signs every session out
        conn.execute("DELETE FROM sessions WHERE account IN (SELECT id FROM accounts WHERE email = ?1)", [email])?;
        Ok(n == 1)
    }

    /// The account and its password hash, if it may sign in.
    pub fn account_by_email(&self, email: &str) -> Result<Option<(Account, Option<String>)>, Error> {
        self.conn()
            .query_row(
                "SELECT id, school, email, token_budget, password FROM accounts WHERE email = ?1 AND disabled IS NULL",
                [email],
                |r| Ok((Account { id: r.get(0)?, school: r.get(1)?, email: r.get(2)?, token_budget: r.get(3)? }, r.get(4)?)),
            )
            .optional()
    }

    pub fn add_session(&self, token_hash: &str, account: &str, expires: &str) -> Result<(), Error> {
        self.conn().execute("INSERT INTO sessions (token_hash, account, expires) VALUES (?1, ?2, ?3)", params![token_hash, account, expires]).map(drop)
    }

    pub fn drop_session(&self, token_hash: &str) -> Result<(), Error> {
        self.conn().execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash]).map(drop)
    }

    /// The account a session belongs to, while it hasn't expired.
    pub fn session(&self, token_hash: &str, now: &str) -> Result<Option<Account>, Error> {
        self.conn()
            .query_row(
                "SELECT a.id, a.school, a.email, a.token_budget FROM sessions s JOIN accounts a ON a.id = s.account
                 WHERE s.token_hash = ?1 AND s.expires > ?2 AND a.disabled IS NULL",
                params![token_hash, now],
                |r| Ok(Account { id: r.get(0)?, school: r.get(1)?, email: r.get(2)?, token_budget: r.get(3)? }),
            )
            .optional()
    }

    pub fn add_draft(&self, d: &Draft) -> Result<(), Error> {
        self.conn()
            .execute(
                "INSERT INTO drafts (id, owner, school, package, title, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![d.id, d.owner, d.school, d.package, d.title, d.created],
            )
            .map(drop)
    }

    fn draft_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Draft> {
        Ok(Draft { id: r.get(0)?, owner: r.get(1)?, school: r.get(2)?, package: r.get(3)?, title: r.get(4)?, created: r.get(5)? })
    }

    /// A draft that isn't deleted, if `owner` owns it.
    pub fn draft(&self, id: &str, owner: &str) -> Result<Option<Draft>, Error> {
        self.conn()
            .query_row(
                "SELECT id, owner, school, package, title, created FROM drafts WHERE id = ?1 AND owner = ?2 AND deleted IS NULL",
                params![id, owner],
                Self::draft_row,
            )
            .optional()
    }

    pub fn drafts(&self, owner: &str) -> Result<Vec<Draft>, Error> {
        let conn = self.conn();
        let mut q = conn.prepare("SELECT id, owner, school, package, title, created FROM drafts WHERE owner = ?1 AND deleted IS NULL ORDER BY created DESC")?;
        q.query_map([owner], Self::draft_row)?.collect()
    }

    pub fn count_drafts(&self, owner: &str) -> Result<i64, Error> {
        self.conn().query_row("SELECT count(*) FROM drafts WHERE owner = ?1 AND deleted IS NULL", [owner], |r| r.get(0))
    }

    pub fn set_draft_title(&self, id: &str, title: &str) -> Result<(), Error> {
        self.conn().execute("UPDATE drafts SET title = ?2 WHERE id = ?1", params![id, title]).map(drop)
    }

    pub fn delete_draft(&self, id: &str, now: &str) -> Result<(), Error> {
        self.conn().execute("UPDATE drafts SET deleted = ?2 WHERE id = ?1", params![id, now]).map(drop)
    }

    fn publication_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Publication> {
        Ok(Publication {
            id: r.get(0)?,
            draft: r.get(1)?,
            owner: r.get(2)?,
            manifest: r.get(3)?,
            definitions: r.get(4)?,
            created: r.get(5)?,
            updated: r.get(6)?,
            revoked: r.get(7)?,
        })
    }

    const PUBLICATION: &str = "SELECT id, draft, owner, manifest, definitions, created, updated, revoked FROM publications";

    /// The draft's publication: one link per draft, kept across versions.
    pub fn publication_of(&self, draft: &str) -> Result<Option<Publication>, Error> {
        self.conn().query_row(&format!("{} WHERE draft = ?1", Self::PUBLICATION), [draft], Self::publication_row).optional()
    }

    pub fn publication(&self, id: &str) -> Result<Option<Publication>, Error> {
        self.conn().query_row(&format!("{} WHERE id = ?1", Self::PUBLICATION), [id], Self::publication_row).optional()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_publication(&self, id: &str, draft: &Draft, manifest: &str, definitions: &str, now: &str) -> Result<(), Error> {
        self.conn()
            .execute(
                "INSERT INTO publications (id, draft, owner, school, manifest, definitions, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, draft.id, draft.owner, draft.school, manifest, definitions, now],
            )
            .map(drop)
    }

    /// A new version; publishing again also switches a revoked link back on.
    pub fn update_publication(&self, id: &str, manifest: &str, definitions: &str, now: &str) -> Result<(), Error> {
        self.conn()
            .execute("UPDATE publications SET manifest = ?2, definitions = ?3, updated = ?4, revoked = NULL WHERE id = ?1", params![id, manifest, definitions, now])
            .map(drop)
    }

    pub fn revoke_publication(&self, id: &str, now: &str) -> Result<(), Error> {
        self.conn().execute("UPDATE publications SET revoked = ?2 WHERE id = ?1 AND revoked IS NULL", params![id, now]).map(drop)
    }

    pub fn add_turn(&self, id: &str, account: &str, draft: &str, now: &str) -> Result<(), Error> {
        self.conn().execute("INSERT INTO turns (id, account, draft, started) VALUES (?1, ?2, ?3, ?4)", params![id, account, draft, now]).map(drop)
    }

    pub fn add_usage(&self, turn: &str, input: i64, output: i64, cache_read: i64, cache_write: i64) -> Result<(), Error> {
        self.conn()
            .execute(
                "UPDATE turns SET input_tokens = input_tokens + ?2, output_tokens = output_tokens + ?3,
                 cache_read_tokens = cache_read_tokens + ?4, cache_write_tokens = cache_write_tokens + ?5 WHERE id = ?1",
                params![turn, input, output, cache_read, cache_write],
            )
            .map(drop)
    }

    /// Tokens an account's turns used since `since` (ISO), weighted as they cost: a cache read a tenth of an input
    /// token, a cache write a quarter more, an output token five.
    pub fn tokens_since(&self, account: &str, since: &str) -> Result<i64, Error> {
        self.conn().query_row(
            "SELECT coalesce(sum(input_tokens + output_tokens * 5 + cache_read_tokens / 10 + cache_write_tokens * 5 / 4), 0)
             FROM turns WHERE account = ?1 AND started >= ?2",
            params![account, since],
            |r| r.get(0),
        )
    }
}
