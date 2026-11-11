use super::*;
use std::os::unix::fs::symlink;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "flowhub-mail-file-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn account(provider: Provider, address: &str) -> Account {
    Account {
        provider,
        address: address.into(),
    }
}
fn entry(address: &str, secret: &str) -> Entry {
    Entry::new(
        &account(Provider::NetEase, address),
        Some(Zeroizing::new(secret.into())),
    )
}

#[test]
fn file_round_trip_update_and_removal_survive_reopening_without_runtime_identity() {
    let root = Root::new();
    let mut store = Store::load(&root.0).unwrap();
    assert!(store.entries.is_empty());
    store
        .replace(vec![
            entry("fixture@163.com", "FixtureSecret123"),
            Entry::new(
                &account(Provider::Qq, "fixture@qq.com"),
                Some(Zeroizing::new("OtherSecret456".into())),
            ),
        ])
        .unwrap();
    assert_eq!(
        fs::metadata(&store.directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.file()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    drop(store);
    let mut reopened = Store::load(&root.0).unwrap();
    assert_eq!(
        reopened.entries[0].secret().unwrap().as_str(),
        "FixtureSecret123"
    );
    assert_eq!(
        reopened.entries[1].secret().unwrap().as_str(),
        "OtherSecret456"
    );
    let path = reopened.file();
    let document: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(document["schema"], 1);
    assert!(document.get("version").is_none());
    assert!(document.get("signingIdentity").is_none());
    let other = reopened.entries.pop().unwrap();
    reopened
        .replace(vec![entry("fixture@163.com", "Replacement789"), other])
        .unwrap();
    let mut reopened = Store::load(&root.0).unwrap();
    assert_eq!(
        reopened.entries[0].secret().unwrap().as_str(),
        "Replacement789"
    );
    reopened.replace(vec![]).unwrap();
    assert!(Store::load(&root.0).unwrap().entries.is_empty());
    assert_eq!(
        fs::read_dir(&reopened.directory).unwrap().count(),
        1,
        "temporary file leaked"
    );
}

#[test]
fn legacy_rows_request_local_codes_without_opening_the_keychain_or_resurrecting_removed_accounts() {
    let root = Root::new();
    let a = account(Provider::NetEase, "fixture@163.com");
    fs::write(
        root.0.join("mail-accounts.json"),
        serde_json::to_vec(&vec![a.clone()]).unwrap(),
    )
    .unwrap();
    let store = Store::load(&root.0).unwrap();
    assert!(store.entries[0].account() == a);
    assert!(store.entries[0].secret().is_none());
    let mut monitor = super::super::Monitor::new(&root.0);
    let status = monitor.status().unwrap();
    assert_eq!(status["credentialStorage"], "local-file");
    assert_eq!(status["accounts"][0]["credentialsMissing"], true);
    assert_eq!(status["accounts"][0]["status"], "authorization");
    assert_eq!(monitor.search_accounts("")[0]["credentialsMissing"], true);
    assert!(!status.to_string().contains("authorizationCode"));
    monitor.remove(&serde_json::json!(a)).unwrap();
    drop(monitor);
    assert!(
        Store::load(&root.0).unwrap().entries.is_empty(),
        "legacy account resurrected after disconnect"
    );
}

#[test]
fn rejects_duplicate_accounts_unsupported_versions_and_invalid_secrets_without_replacing_data() {
    let root = Root::new();
    let mut store = Store::load(&root.0).unwrap();
    let first = entry("fixture@163.com", "FixtureSecret123");
    store.replace(vec![first.clone()]).unwrap();
    let original = fs::read(store.file()).unwrap();
    for entries in [
        vec![first.clone(), first.clone()],
        vec![entry("fixture@163.com", "contains spaces")],
        vec![entry("not-an-email", "Valid123")],
        (0..9)
            .map(|i| entry(&format!("fixture{i}@163.com"), "Valid123"))
            .collect(),
    ] {
        assert!(store.replace(entries).is_err());
        assert_eq!(fs::read(store.file()).unwrap(), original);
    }
    fs::write(store.file(), b"{\"schema\":99,\"accounts\":[]}").unwrap();
    assert!(Store::load(&root.0).is_err());
    fs::write(store.file(), b"{FixtureSecret123").unwrap();
    let error = Store::load(&root.0).err().unwrap();
    assert!(!error.contains("FixtureSecret123"));
    let mut monitor = super::super::Monitor::new(&root.0);
    assert!(monitor.add(mut_value()).is_err());
    assert_eq!(fs::read(store.file()).unwrap(), b"{FixtureSecret123");
}
fn mut_value() -> serde_json::Value {
    serde_json::json!({"provider":"netease","address":"fixture@163.com","authorizationCode":"Valid123"})
}

#[test]
fn permissions_are_repaired_and_oversized_files_fail_closed() {
    let root = Root::new();
    let mut store = Store::load(&root.0).unwrap();
    store
        .replace(vec![entry("fixture@163.com", "Valid123")])
        .unwrap();
    fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(store.file(), fs::Permissions::from_mode(0o644)).unwrap();
    let _ = Store::load(&root.0).unwrap();
    assert_eq!(
        fs::metadata(&store.directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.file()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::write(store.file(), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
    assert!(Store::load(&root.0).is_err());
}

#[test]
fn links_and_non_regular_files_are_rejected_without_touching_their_targets() {
    let root = Root::new();
    let outside = root.0.join("outside");
    fs::create_dir(&outside).unwrap();
    let mut store = Store::empty(&root.0);
    symlink(&outside, &store.directory).unwrap();
    assert!(Store::load(&root.0).is_err());
    assert!(store.replace(vec![]).is_err());
    fs::remove_file(&store.directory).unwrap();
    fs::create_dir(&store.directory).unwrap();
    let secret = outside.join("unrelated");
    fs::write(&secret, "keep").unwrap();
    symlink(&secret, store.file()).unwrap();
    assert!(Store::load(&root.0).is_err());
    assert!(store.replace(vec![]).is_err());
    assert_eq!(fs::read(&secret).unwrap(), b"keep");
    fs::remove_file(store.file()).unwrap();
    fs::hard_link(&secret, store.file()).unwrap();
    assert!(Store::load(&root.0).is_err());
    assert!(store.replace(vec![]).is_err());
    fs::remove_file(store.file()).unwrap();
    fs::create_dir(store.file()).unwrap();
    assert!(Store::load(&root.0).is_err());
    assert!(store.replace(vec![]).is_err());
    assert_eq!(fs::read(&secret).unwrap(), b"keep");
}
