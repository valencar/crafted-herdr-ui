//! Helpers shared by the integration tests. Each test crate uses only part of this.
#![allow(dead_code)]

use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// `scripts/fake-hc`, the JSON-RPC stand-in for herdr-core's `hc`.
pub fn fake_hc_bin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-hc")
}

/// The directory holding `node`, found on the test process's own `PATH` (resolved once).
fn node_dir() -> &'static str {
    static NODE_DIR: OnceLock<String> = OnceLock::new();
    NODE_DIR.get_or_init(|| {
        let path = env::var_os("PATH").expect("PATH is not set");
        env::split_paths(&path)
            .find(|d| d.join("node").is_file())
            .expect("node not found on PATH; fake-hc needs it")
            .display()
            .to_string()
    })
}

/// The environment a test gives fake-hc after `env_clear()`: node's directory plus the system
/// basics on `PATH` (the shebang is `env node`), and `FAKE_HC_DIR` pointing at the fixtures.
pub fn fake_hc_env(dir: &Path) -> Vec<(String, String)> {
    vec![
        ("PATH".to_string(), format!("{}:/usr/bin:/bin", node_dir())),
        ("FAKE_HC_DIR".to_string(), dir.display().to_string()),
    ]
}
