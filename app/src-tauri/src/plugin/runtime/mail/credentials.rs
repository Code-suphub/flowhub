//! Mail authorization codes stay in a host-owned, current-user-only file.
//! This module never opens the keychain and never returns secrets to plugin RPC.
use super::{Account, Provider, MAX_ACCOUNTS};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

const MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone)]
pub(super) struct Secret(pub Zeroizing<String>);
impl Serialize for Secret {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.as_str())
    }
}
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(|v| Self(Zeroizing::new(v)))
    }
}
pub(super) fn valid_secret(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    provider: Provider,
    address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authorization_code: Option<Secret>,
}
impl Entry {
    pub(super) fn new(account: &Account, secret: Option<Zeroizing<String>>) -> Self {
        Self {
            provider: account.provider,
            address: account.address.clone(),
            authorization_code: secret.map(Secret),
        }
    }
    pub(super) fn account(&self) -> Account {
        Account {
            provider: self.provider,
            address: self.address.clone(),
        }
    }
    pub(super) fn secret(&self) -> Option<Zeroizing<String>> {
        self.authorization_code.as_ref().map(|s| s.0.clone())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    schema: u32,
    accounts: Vec<Entry>,
}

pub(super) struct Store {
    directory: PathBuf,
    pub entries: Vec<Entry>,
}

fn validate(entries: &[Entry]) -> Result<(), String> {
    if entries.len() > MAX_ACCOUNTS {
        return Err("邮箱凭据文件包含过多账户".into());
    }
    let mut accounts = BTreeSet::new();
    for entry in entries {
        let account = entry.account();
        let parsed =
            Account::parse(&serde_json::json!(account)).map_err(|_| "邮箱凭据文件格式无效")?;
        if account != parsed
            || !accounts.insert(account)
            || entry
                .authorization_code
                .as_ref()
                .is_some_and(|s| !valid_secret(s.0.as_str()))
        {
            return Err("邮箱凭据文件格式无效".into());
        }
    }
    Ok(())
}
fn owned_regular(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_file()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.nlink() == 1
}
impl Store {
    pub(super) fn empty(root: &Path) -> Self {
        Self {
            directory: root.join("mail-credentials"),
            entries: vec![],
        }
    }
    fn file(&self) -> PathBuf {
        self.directory.join("accounts.json")
    }
    fn secure_directory(&self, create: bool) -> Result<bool, String> {
        if create {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.directory)
                .map_err(|_| "无法创建邮箱凭据目录")?;
        }
        let metadata = match fs::symlink_metadata(&self.directory) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("无法核验邮箱凭据目录".into()),
        };
        if !metadata.file_type().is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("邮箱凭据目录必须是当前用户的普通目录".into());
        }
        fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护邮箱凭据目录")?;
        Ok(true)
    }
    pub(super) fn load(root: &Path) -> Result<Self, String> {
        let mut store = Self::empty(root);
        if store.secure_directory(false)? {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(store.file());
            match file {
                Ok(mut file) => {
                    let metadata = file.metadata().map_err(|_| "无法核验邮箱凭据文件")?;
                    if !owned_regular(&metadata) || metadata.len() > MAX_BYTES {
                        return Err("邮箱凭据文件无效".into());
                    }
                    file.set_permissions(fs::Permissions::from_mode(0o600))
                        .map_err(|_| "无法保护邮箱凭据文件")?;
                    let mut bytes = Zeroizing::new(Vec::new());
                    (&mut file)
                        .take(MAX_BYTES + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "无法读取邮箱凭据文件")?;
                    if bytes.len() as u64 > MAX_BYTES {
                        return Err("邮箱凭据文件过大".into());
                    }
                    let document: Document = serde_json::from_slice(&bytes)
                        .map_err(|_| "邮箱凭据文件格式无效，请保留文件并检查配置")?;
                    if document.schema != 1 {
                        return Err("邮箱凭据文件版本不受支持".into());
                    }
                    validate(&document.accounts)?;
                    store.entries = document.accounts;
                    return Ok(store);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法读取邮箱凭据文件".into()),
            }
        }
        // Preserve old account rows, but never open the former keychain item.
        // They show a one-time re-entry request until the user supplies a code.
        match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join("mail-accounts.json"))
        {
            Ok(mut file) => {
                let metadata = file.metadata().map_err(|_| "无法核验邮箱配置文件")?;
                if !metadata.is_file() || metadata.len() > MAX_BYTES {
                    return Err("邮箱配置文件过大".into());
                }
                let mut bytes = Zeroizing::new(Vec::new());
                (&mut file)
                    .take(MAX_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "邮箱配置无法读取")?;
                if bytes.len() as u64 > MAX_BYTES {
                    return Err("邮箱配置文件过大".into());
                }
                let accounts: Vec<Account> =
                    serde_json::from_slice(&bytes).map_err(|_| "邮箱配置无法读取".to_owned())?;
                store.entries = accounts
                    .iter()
                    .map(|account| Entry::new(account, None))
                    .collect();
                validate(&store.entries)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("邮箱配置无法读取".into()),
        }
        Ok(store)
    }
    pub(super) fn replace(&mut self, entries: Vec<Entry>) -> Result<(), String> {
        validate(&entries)?;
        self.secure_directory(true)?;
        match fs::symlink_metadata(self.file()) {
            Ok(metadata) if !owned_regular(&metadata) => {
                return Err("邮箱凭据文件必须是当前用户的普通文件".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err("无法核验邮箱凭据文件".into())
            }
            _ => {}
        }
        let bytes = Zeroizing::new(
            serde_json::to_vec(&Document {
                schema: 1,
                accounts: entries.clone(),
            })
            .map_err(|_| "无法编码邮箱凭据")?,
        );
        let temporary = self.directory.join(format!(
            ".accounts-{}-{}.tmp",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "无法创建邮箱凭据文件")?;
        let result = file
            .write_all(&bytes)
            .and_then(|_| file.sync_all())
            .and_then(|_| fs::rename(&temporary, self.file()));
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("无法保存邮箱凭据，原有连接保持不变".into());
        }
        // Directory fsync is best effort after the durable atomic replacement.
        let _ = File::open(&self.directory).and_then(|directory| directory.sync_all());
        self.entries = entries;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
