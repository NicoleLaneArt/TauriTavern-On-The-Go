//! Phone side: keeps pictures fetched from the PC on the phone.
//!
//! A cached picture is shown at once; the phone then asks the PC in the
//! background whether it changed (a tiny 304 when it did not) and refreshes the
//! copy for next time. Over Tailscale this turns every repeat avatar,
//! thumbnail and background into a local read.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_TOTAL_BYTES: u64 = 400 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 25 * 1024 * 1024;
const REVALIDATE_EVERY: Duration = Duration::from_secs(10 * 60);
const PRUNE_EVERY_WRITES: u32 = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedMeta {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

impl CachedMeta {
    pub fn etag(&self) -> Option<&str> {
        self.headers
            .iter()
            .find(|(name, _)| name == "etag")
            .map(|(_, value)| value.as_str())
    }
}

pub struct PictureCache {
    dir: PathBuf,
    checked: Mutex<HashMap<String, Instant>>,
    writes: AtomicU32,
}

impl PictureCache {
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        Self {
            dir,
            checked: Mutex::new(HashMap::new()),
            writes: AtomicU32::new(0),
        }
    }

    /// The PC address is part of the key so two PCs never share pictures.
    pub fn key(base: &str, path_and_query: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(base.as_bytes());
        hasher.update([0]);
        hasher.update(path_and_query.as_bytes());
        hasher
            .finalize()
            .iter()
            .take(20)
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn paths(&self, key: &str) -> (PathBuf, PathBuf) {
        (
            self.dir.join(format!("{key}.json")),
            self.dir.join(format!("{key}.bin")),
        )
    }

    pub fn get(&self, key: &str) -> Option<(CachedMeta, Vec<u8>)> {
        let (meta_path, body_path) = self.paths(key);
        let meta: CachedMeta = serde_json::from_slice(&fs::read(meta_path).ok()?).ok()?;
        let body = fs::read(body_path).ok()?;
        Some((meta, body))
    }

    pub fn put(&self, key: &str, meta: &CachedMeta, body: &[u8]) {
        if body.len() > MAX_ENTRY_BYTES {
            return;
        }
        let (meta_path, body_path) = self.paths(key);
        let write = |path: &PathBuf, bytes: &[u8]| -> std::io::Result<()> {
            let tmp = path.with_extension("tmp");
            fs::write(&tmp, bytes)?;
            fs::rename(&tmp, path)
        };
        let Ok(meta_bytes) = serde_json::to_vec(meta) else {
            return;
        };
        if write(&body_path, body).is_err() || write(&meta_path, &meta_bytes).is_err() {
            self.remove(key);
            return;
        }
        self.mark_checked(key);
        if self.writes.fetch_add(1, Ordering::Relaxed) % PRUNE_EVERY_WRITES == 0 {
            self.prune();
        }
    }

    /// Still fresh: refresh its age so pruning keeps it.
    pub fn touch(&self, key: &str) {
        let (_, body_path) = self.paths(key);
        if let Ok(file) = fs::File::options().write(true).open(&body_path) {
            let _ = file.set_modified(std::time::SystemTime::now());
        }
        self.mark_checked(key);
    }

    pub fn remove(&self, key: &str) {
        let (meta_path, body_path) = self.paths(key);
        let _ = fs::remove_file(meta_path);
        let _ = fs::remove_file(body_path);
    }

    /// True when this picture has not been checked with the PC recently;
    /// marks it as being checked now.
    pub fn should_check(&self, key: &str) -> bool {
        let mut checked = self.checked.lock().expect("picture cache lock");
        let now = Instant::now();
        match checked.get(key) {
            Some(at) if now.duration_since(*at) < REVALIDATE_EVERY => false,
            _ => {
                checked.insert(key.to_string(), now);
                true
            }
        }
    }

    fn mark_checked(&self, key: &str) {
        self.checked
            .lock()
            .expect("picture cache lock")
            .insert(key.to_string(), Instant::now());
    }

    /// Drops the least recently used pictures once the cache passes its cap.
    fn prune(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut bodies: Vec<(std::time::SystemTime, u64, String)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let key = name.strip_suffix(".bin")?.to_string();
                let meta = entry.metadata().ok()?;
                Some((meta.modified().ok()?, meta.len(), key))
            })
            .collect();
        let mut total: u64 = bodies.iter().map(|(_, len, _)| len).sum();
        if total <= MAX_TOTAL_BYTES {
            return;
        }
        bodies.sort_by_key(|(modified, _, _)| *modified);
        for (_, len, key) in bodies {
            if total <= MAX_TOTAL_BYTES * 8 / 10 {
                break;
            }
            self.remove(&key);
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("ttpc-{}", uuid::Uuid::new_v4()));
        let cache = PictureCache::new(dir.clone());
        let key = PictureCache::key("http://100.64.0.1:8124/", "/thumbnail?type=avatar&file=a.png");
        assert!(cache.get(&key).is_none());
        let meta = CachedMeta {
            status: 200,
            headers: vec![("etag".into(), "W/\"1\"".into())],
        };
        cache.put(&key, &meta, b"png");
        let (read_meta, body) = cache.get(&key).unwrap();
        assert_eq!(body, b"png");
        assert_eq!(read_meta.etag(), Some("W/\"1\""));
        assert!(!cache.should_check(&key));
        let _ = fs::remove_dir_all(dir);
    }
}
