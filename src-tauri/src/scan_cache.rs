//! Serializes cache creation/eviction and pins prepared files until the frontend
//! finishes reading them. Leases belong to a window and are cleared on destruction.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Default)]
pub struct ScanCache {
    leases: HashMap<String, (String, PathBuf)>,
    next_id: u64,
    limit: u64,
    last_used: HashMap<PathBuf, SystemTime>,
}

pub fn state() -> &'static Mutex<ScanCache> {
    static CACHE: OnceLock<Mutex<ScanCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ScanCache::default()))
}

pub fn limit_bytes(gib: Option<u64>) -> u64 {
    let value = gib
        .filter(|value| [2, 4, 8, 16, 32, 64, 128].contains(value))
        .unwrap_or(16);
    value * 1024 * 1024 * 1024
}

impl ScanCache {
    pub fn acquire(&mut self, path: &Path, owner: &str, limit: u64) -> Result<String, String> {
        // Updating only the derived copy preserves source metadata/hash identity.
        let now = SystemTime::now();
        self.last_used.insert(path.to_owned(), now);
        // A read-only source can produce a read-only copy. Still allow reading
        // it; keep its access time in memory if the filesystem cannot update it.
        let _ = fs::File::options()
            .write(true)
            .open(path)
            .and_then(|file| file.set_modified(now));
        self.limit = limit;
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.leases
            .insert(id.clone(), (owner.to_owned(), path.to_owned()));
        self.prune(path.parent().ok_or("影像缓存路径没有父目录")?);
        Ok(id)
    }

    pub fn release(&mut self, id: &str, owner: &str) {
        if self
            .leases
            .get(id)
            .is_some_and(|(window, _)| window == owner)
        {
            if let Some((_, path)) = self.leases.remove(id) {
                if let Some(dir) = path.parent() {
                    self.prune(dir);
                }
            }
        }
    }

    pub fn release_window(&mut self, owner: &str) {
        let ids: Vec<_> = self
            .leases
            .iter()
            .filter(|(_, (window, _))| window == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.release(&id, owner);
        }
    }

    fn prune(&mut self, dir: &Path) {
        let protected: HashSet<_> = self.leases.values().map(|(_, path)| path.clone()).collect();
        prune(dir, self.limit, &protected, &self.last_used);
        self.last_used.retain(|path, _| path.exists());
    }
}

fn prune(
    dir: &Path,
    limit: u64,
    protected: &HashSet<PathBuf>,
    last_used: &HashMap<PathBuf, SystemTime>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let used = last_used
                .get(&entry.path())
                .copied()
                .unwrap_or_else(|| metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH));
            Some((entry.path(), metadata.len(), used))
        })
        .collect();
    let mut bytes: u64 = files.iter().map(|(_, size, _)| size).sum();
    files.sort_by_key(|(_, _, used)| *used);
    for (path, size, _) in files {
        if bytes <= limit {
            break;
        }
        if protected.contains(&path) {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            bytes = bytes.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "idm-scan-cache-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn file(&self, name: &str, age: u64) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, [0_u8; 10]).unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(age))
                .unwrap();
            path
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn active_files_can_exceed_budget_until_last_reader_releases() {
        let temp = Temp::new();
        let a = temp.file("a.png", 1);
        let mut cache = ScanCache::default();
        let first = cache.acquire(&a, "main", 5).unwrap();
        let second = cache.acquire(&a, "chart", 5).unwrap();
        assert!(a.exists());
        cache.release(&first, "chart"); // Other windows cannot release this lease.
        cache.release(&first, "main");
        assert!(a.exists());
        cache.release(&second, "chart");
        assert!(!a.exists());
    }

    #[test]
    fn recent_hit_updates_lru_and_closed_window_releases_its_pins() {
        let temp = Temp::new();
        let a = temp.file("a.png", 1);
        let b = temp.file("b.png", 2);
        let mut cache = ScanCache::default();
        let lease = cache.acquire(&a, "main", 30).unwrap();
        cache.release(&lease, "main");
        let c = temp.file("c.png", 3);
        cache.acquire(&c, "chart", 20).unwrap();
        assert!(a.exists() && c.exists());
        assert!(!b.exists());
        cache.limit = 5;
        cache.release_window("chart");
        assert!(!a.exists() && !c.exists());
    }

    #[test]
    fn budget_is_validated() {
        assert_eq!(limit_bytes(None), 16 * 1024 * 1024 * 1024);
        assert_eq!(limit_bytes(Some(128)), 128 * 1024 * 1024 * 1024);
        assert_eq!(limit_bytes(Some(u64::MAX)), limit_bytes(None));
    }

    #[test]
    fn concurrent_files_are_protected_independently() {
        let temp = Temp::new();
        let a = temp.file("a.png", 1);
        let mut cache = ScanCache::default();
        let first = cache.acquire(&a, "main", 5).unwrap();
        let b = temp.file("b.png", 2);
        let second = cache.acquire(&b, "chart", 5).unwrap();
        assert!(a.exists() && b.exists());
        cache.release(&first, "main");
        assert!(!a.exists() && b.exists());
        cache.release(&second, "chart");
        assert!(!b.exists());
        assert!(cache.last_used.is_empty());
    }
}
