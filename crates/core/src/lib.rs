//! gestalts core: ymls and blobs behind a storage port, the one gestalt each yml names, querying and merging.
//! No IO here; adapters live in `gestalts-fs` (disk) and `gestalts-wasm` (browser).

pub mod blobs;
pub mod decks;
pub mod gestalt;
pub mod index;
pub mod mastery;
pub mod merge;
pub mod repo;
pub mod storage;
pub mod sync;
pub mod yml;

pub use blobs::{BlobRefs, GcManifest, blobs_of, collect_blobs, referenced_blobs};
pub use decks::{DeckRef, Decks, Merged};
pub use gestalt::{Edge, GestaltDef, Gestalts, Problem, YmlState};
pub use gestalts_merge::{Conflict, Policy, Segment};
pub use index::{Item, Order, Page, Query, RefFilter, TagFilter};
pub use mastery::{Belief, Mastery, MasteryParams};
pub use merge::{YmlMerge, conflict_yml, is_tombstone, iso_datetime, parse_iso_datetime, is_tombstone_text, merge_yml, tombstone};
pub use repo::{BeliefDelta, Delta, Health, Repo, SubId, new_id, stable_id, state_id};
pub use storage::{Deck, Hashes, Layered, Memory, Storage, StorageError, Tracked};
pub use sync::{Fetched, NoteCounts, Pending, SYNC_STEPS, SyncBase, SyncReport, fetch_remote, merge_local, push, sync, sync_with};
pub use yml::{ParseError, Yml, content_hash};
pub use serde_yaml_ng::Value;
