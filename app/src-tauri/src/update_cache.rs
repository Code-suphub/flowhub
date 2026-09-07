use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CachedUpdate {
    pub version: String,
    pub target: String,
    pub arch: String,
    pub url: String,
    pub signature: String,
    pub notes: String,
    pub date: String,
    pub size: u64,
    pub sha256: String,
}

impl CachedUpdate {
    pub fn matches(&self, update: &tauri_plugin_updater::Update) -> bool {
        self.arch == std::env::consts::ARCH
            && self.version == update.version
            && self.target == update.target
            && self.url == update.download_url.as_str()
            && self.signature == update.signature
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("partial");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

pub(crate) fn save(
    dir: &Path,
    mut metadata: CachedUpdate,
    bytes: &[u8],
) -> Result<CachedUpdate, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Publish the manifest last; a partial download can never appear installable.
    clear(dir)?;
    metadata.size = bytes.len() as u64;
    metadata.sha256 = format!("{:x}", Sha256::digest(bytes));
    atomic_write(&dir.join("package.bin"), bytes)?;
    atomic_write(
        &dir.join("manifest.json"),
        &serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
    )?;
    Ok(metadata)
}

pub(crate) fn read(dir: &Path) -> Result<Option<CachedUpdate>, String> {
    let path = dir.join("manifest.json");
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| e.to_string())
}

pub(crate) fn bytes(dir: &Path, metadata: &CachedUpdate) -> Result<Vec<u8>, String> {
    let data = fs::read(dir.join("package.bin")).map_err(|e| e.to_string())?;
    if data.len() as u64 != metadata.size
        || format!("{:x}", Sha256::digest(&data)) != metadata.sha256
    {
        return Err("本地更新包不完整或已损坏，请重新下载".into());
    }
    Ok(data)
}

pub(crate) fn verify(data: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    let decode = |text: &str| -> Result<String, String> {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&decode(pubkey)?).map_err(|e| e.to_string())?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(data, &signature, true)
        .map_err(|e| e.to_string())
}

pub(crate) fn clear(dir: &Path) -> Result<(), String> {
    for name in [
        "manifest.json",
        "package.bin",
        "manifest.partial",
        "package.partial",
    ] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metadata() -> CachedUpdate {
        CachedUpdate {
            version: "1.2.3".into(),
            target: "darwin".into(),
            arch: std::env::consts::ARCH.into(),
            url: "https://example.com/update".into(),
            signature: "signature".into(),
            notes: String::new(),
            date: String::new(),
            size: 0,
            sha256: String::new(),
        }
    }
    #[test]
    fn cached_signature_is_checked_again_after_disk_read() {
        // Public test vector from minisign-verify 0.2.5 (MIT).
        let key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let encode = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        assert!(verify(b"test", &encode(signature), &encode(key)).is_ok());
        assert!(verify(b"Test", &encode(signature), &encode(key)).is_err());
    }
    #[test]
    fn survives_restart_and_rejects_truncated_or_modified_package() {
        let dir = std::env::temp_dir().join(format!("flowhub-cache-test-{}", std::process::id()));
        let saved = save(&dir, metadata(), b"verified package").unwrap();
        let restored = read(&dir).unwrap().unwrap();
        assert_eq!(restored.version, saved.version);
        assert_eq!(bytes(&dir, &restored).unwrap(), b"verified package");
        fs::write(dir.join("package.bin"), b"verified packagE").unwrap();
        assert!(bytes(&dir, &restored).is_err());
        fs::write(dir.join("package.bin"), b"partial").unwrap();
        assert!(bytes(&dir, &restored).is_err());
        clear(&dir).unwrap();
        fs::write(dir.join("package.partial"), b"interrupted download").unwrap();
        assert!(read(&dir).unwrap().is_none());
        clear(&dir).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
