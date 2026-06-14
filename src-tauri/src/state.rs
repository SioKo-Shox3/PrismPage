use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

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

#[derive(Clone)]
pub struct RunningEnhancementJob {
    pub reader_session_id: String,
    pub child: Arc<Mutex<Option<Child>>>,
    pub canceled: Arc<AtomicBool>,
}

pub struct EnhancementJobState {
    pub running: HashMap<String, RunningEnhancementJob>,
    pub canceled_sessions: HashSet<String>,
    pub canceled_session_order: VecDeque<String>,
}

pub struct EnhancementJobs(pub Mutex<EnhancementJobState>);

impl Default for EnhancementJobs {
    fn default() -> Self {
        Self(Mutex::new(EnhancementJobState {
            running: HashMap::new(),
            canceled_sessions: HashSet::new(),
            canceled_session_order: VecDeque::new(),
        }))
    }
}
