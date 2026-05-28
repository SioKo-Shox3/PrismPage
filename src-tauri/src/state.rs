use std::sync::Mutex;

pub struct RegistryLock(pub Mutex<()>);

impl Default for RegistryLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}
