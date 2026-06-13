use std::sync::Mutex;

pub struct OpenedEpubPaths(pub Mutex<Vec<String>>);

impl Default for OpenedEpubPaths {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

pub struct RegistryLock(pub Mutex<()>);

impl Default for RegistryLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}

pub struct EnhancementLock(pub Mutex<()>);

impl Default for EnhancementLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}
