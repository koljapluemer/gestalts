use std::sync::{Arc, Mutex as StdMutex};

use gestalts_core::Memory;

use super::*;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gestalts-device-{name}-{}-{}", std::process::id(), now_ms()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Records what the device tells the app.
#[derive(Clone, Default)]
struct Recorder(Arc<StdMutex<Vec<Event>>>);

impl Host for Recorder {
    fn event(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}

impl Recorder {
    fn changed(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().filter_map(|e| match e { Event::Changed { notes, .. } => Some(notes.clone()), _ => None }).flatten().collect()
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, f)
}

#[test]
fn syncs_both_ways_and_tells_the_app() {
    block_on(async {
        let dir = temp_dir("sync");
        let rec = Recorder::default();
        let device = Device::open(&dir, Box::new(rec.clone())).unwrap();
        let remote = Memory::default();
        remote.write_note("from-desktop", "id: from-desktop\n").await.unwrap();
        device.write_note("from-phone", "id: from-phone\n").await.unwrap();

        let report = device.sync_with(&remote, &dir.join("base")).await.unwrap();
        assert_eq!((report.pulled.clone(), report.pushed.clone()), (vec!["from-desktop".to_owned()], vec!["from-phone".to_owned()]));
        assert!(dir.join("folder/notes/from-desktop.yml").exists());
        assert_eq!(remote.read_note("from-phone").await.unwrap().as_deref(), Some("id: from-phone\n"));
        assert_eq!(rec.changed(), vec!["from-desktop".to_owned()]);

        // nothing new: nothing to do, nothing read
        let again = device.sync_with(&remote, &dir.join("base")).await.unwrap();
        assert!(again.pulled.is_empty() && again.pushed.is_empty() && again.compared == 0, "{again:?}");
    });
}

#[test]
fn a_conflict_is_recorded_on_both_sides() {
    block_on(async {
        let dir = temp_dir("conflict");
        let rec = Recorder::default();
        let device = Device::open(&dir, Box::new(rec.clone())).unwrap();
        let remote = Memory::default();
        remote.write_note("n", "id: n\ntitle: base\n").await.unwrap();
        device.sync_with(&remote, &dir.join("base")).await.unwrap();
        device.write_note("n", "id: n\ntitle: phone\n").await.unwrap();
        remote.write_note("n", "id: n\ntitle: desktop\n").await.unwrap();

        let report = device.sync_with(&remote, &dir.join("base")).await.unwrap();
        assert_eq!(report.conflicts.len(), 1, "{report:?}");
        let ck = &report.conflicts[0];
        assert!(remote.read_note(ck).await.unwrap().is_some());
        assert!(device.notes().read_note(ck).await.unwrap().is_some());
        assert!(rec.changed().contains(ck));
    });
}

#[test]
fn the_plugins_gestalts_and_the_pairing_are_kept() {
    let dir = temp_dir("kept");
    let device = Device::open(&dir, Box::new(Recorder::default())).unwrap();
    assert_eq!(device.status().state, SyncState::Off);
    assert!(device.set_gestalts(vec!["not: [a gestalt".into()]).is_err());
    let def = "name: thing\nversion: 1\nfields:\n  main: { type: text }\n".to_owned();
    device.set_gestalts(vec![def.clone()]).unwrap();
    let saved: Vec<String> = read_json(&dir.join("gestalts.json")).unwrap().unwrap();
    assert_eq!(saved, vec![def]);
    assert!(Device::open(&dir, Box::new(Recorder::default())).unwrap().gestalts.borrow().defs().iter().any(|d| d.name == "thing"));
    let node = PairedNode { node_id: "a".repeat(64), name: "Desk".into(), addrs: vec!["192.0.2.1:7718".into()], device_id: "d".into(), token: "t".into() };
    write_json(&dir.join("paired.json"), &node).unwrap();
    let device = Device::open(&dir, Box::new(Recorder::default())).unwrap();
    assert_eq!(device.status().paired, Some(NodeInfo { node_id: "a".repeat(64), name: "Desk".into() }));
    device.forget().unwrap();
    assert!(!dir.join("paired.json").exists());
    assert_eq!(device.status().state, SyncState::Off);
}

#[test]
fn a_handle_reaches_the_device_from_other_threads() {
    let dir = temp_dir("handle");
    let handle = spawn(dir.clone(), Recorder::default()).unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    rt.block_on(async {
        let writes: Vec<_> = (0..20).map(|i| {
            let h = handle.clone();
            tokio::spawn(async move { h.write_note(format!("n{i}"), format!("id: n{i}\n")).await })
        }).collect();
        for w in writes {
            w.await.unwrap().unwrap();
        }
        assert_eq!(handle.list_notes().await.unwrap().len(), 20);
        assert_eq!(handle.read_notes(vec!["n3".into(), "missing".into()]).await.unwrap(), vec![("n3".into(), "id: n3\n".into())]);
        handle.write_blob("b.png".into(), vec![1, 2, 3]).await.unwrap();
        assert_eq!(handle.read_blob("b.png".into()).await.unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(handle.note_hashes().await.unwrap().len(), 20);
        assert!(handle.sync_soon().await.is_ok(), "not paired: nothing happens");
        assert_eq!(handle.status().await.unwrap().state, SyncState::Off);
    });
}
