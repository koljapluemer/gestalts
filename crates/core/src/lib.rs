//! gestalts core: notes (YAML) and blobs behind a storage port, gestalts, querying and merging.
//! No IO here; adapters live in `gestalts-fs` (disk) and `gestalts-wasm` (browser).

pub mod bib;
pub mod blobs;
pub mod gestalt;
pub mod merge;
pub mod note;
pub mod repo;
pub mod storage;
pub mod upstream;

pub use blobs::{GcManifest, collect_blobs, referenced_blobs, used_blobs};
pub use gestalt::{GestaltDef, Gestalts, Lint, card_id};
pub use gestalts_merge::{Conflict, Policy, Segment};
pub use merge::{NoteCounts, NoteMerge, SYNC_STEPS, SyncReport, conflict_note, is_tombstone, iso_datetime, is_tombstone_text, merge_note, sync, sync_with, tombstone};
pub use note::{Note, ParseError, Ref};
pub use repo::{IndexedNote, Query, Repo, new_id, stable_id, state_key};
pub use storage::{Deck, Layered, Memory, Storage, StorageError};
pub use upstream::{DeckRef, UpstreamReport, content_hash, copies_of, pull_upstream};
pub use serde_yaml_ng::Value;
