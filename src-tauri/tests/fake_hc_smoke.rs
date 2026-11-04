//! Proves `common::fake_hc_env` works: node is found on a cleared `PATH`.

mod common;

use std::process::Command;

use tempfile::TempDir;

#[test]
fn fake_hc_runs_under_a_cleared_env() {
    let dir = TempDir::new().unwrap();
    let out = Command::new(common::fake_hc_bin())
        .arg("--version")
        .env_clear()
        .envs(common::fake_hc_env(dir.path()))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "hc 0.1.17\n");
}
