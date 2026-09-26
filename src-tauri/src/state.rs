use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use crate::services::store::ItemKind;

pub struct RegistryLock(pub Mutex<()>);

impl Default for RegistryLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}

/// 開いた本の ID から、データベースの本の行(`items.id`)を引く表。`open_book` が登録する。
#[derive(Default)]
pub struct BookItems(Mutex<HashMap<String, i64>>);

impl BookItems {
    pub fn insert(&self, book_id: String, item_id: i64) {
        self.lock().insert(book_id, item_id);
    }

    pub fn lock(&self) -> MutexGuard<'_, HashMap<String, i64>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 開いた本の ID から、本の場所(正規化した絶対パス)と種類を引く表。`open_book` が登録し、
/// 前の巻・次の巻を求めるときに使う。
#[derive(Default)]
pub struct BookRoots(Mutex<HashMap<String, (PathBuf, ItemKind)>>);

impl BookRoots {
    pub fn insert(&self, book_id: String, root: PathBuf, kind: ItemKind) {
        self.lock().insert(book_id, (root, kind));
    }

    pub fn lock(&self) -> MutexGuard<'_, HashMap<String, (PathBuf, ItemKind)>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
