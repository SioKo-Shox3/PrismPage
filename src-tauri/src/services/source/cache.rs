//! 開いた本のハンドルのキャッシュ。アーカイブを開き直さないために使い、
//! 上限を超えたら最も長く使われていない本から手放す。

use std::sync::{Arc, Mutex, MutexGuard};

use super::PageSource;

pub struct BookCache {
    capacity: usize,
    /// 先頭ほど最近使われた本。
    entries: Mutex<Vec<(String, Arc<dyn PageSource>)>>,
}

impl BookCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: Mutex::new(Vec::new()),
        }
    }

    /// 本を置く。同じ ID があれば差し替える。
    pub fn insert(&self, book_id: String, source: Arc<dyn PageSource>) {
        let mut entries = self.lock();
        entries.retain(|(id, _)| *id != book_id);
        entries.insert(0, (book_id, source));
        entries.truncate(self.capacity);
    }

    /// 開いている本のハンドルを返し、最近使った本として先頭へ移す。
    pub fn get(&self, book_id: &str) -> Option<Arc<dyn PageSource>> {
        let mut entries = self.lock();
        let position = entries.iter().position(|(id, _)| id == book_id)?;
        let entry = entries.remove(position);
        let source = Arc::clone(&entry.1);
        entries.insert(0, entry);
        Some(source)
    }

    /// 本を手放し、キャッシュから外したハンドルを返す。無ければ `None`。
    /// ハンドルを落とすと(ほかに使っている所が無ければ)一時領域などの後片付けが走る。
    pub fn remove(&self, book_id: &str) -> Option<Arc<dyn PageSource>> {
        let mut entries = self.lock();
        let position = entries.iter().position(|(id, _)| id == book_id)?;
        Some(entries.remove(position).1)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// 読み出し中の panic で毒されても、キャッシュの中身(ハンドルの一覧)は壊れないので使い続ける。
    fn lock(&self) -> MutexGuard<'_, Vec<(String, Arc<dyn PageSource>)>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppResult;
    use crate::models::PageInfo;

    struct Fake(Vec<PageInfo>);

    impl PageSource for Fake {
        fn pages(&self) -> &[PageInfo] {
            &self.0
        }

        fn read_page(&self, _index: usize) -> AppResult<Vec<u8>> {
            Ok(Vec::new())
        }
    }

    fn fake() -> Arc<dyn PageSource> {
        Arc::new(Fake(Vec::new()))
    }

    #[test]
    fn evicts_the_least_recently_used_book() {
        let cache = BookCache::new(2);
        cache.insert("a".into(), fake());
        cache.insert("b".into(), fake());
        assert!(cache.get("a").is_some());

        cache.insert("c".into(), fake());

        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_some());
        assert_eq!(cache.len(), 2);
    }
}
