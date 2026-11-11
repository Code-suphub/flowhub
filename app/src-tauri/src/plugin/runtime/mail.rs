use imap::{Client, Session};
use mail_parser::MessageParser;
use native_tls::{TlsConnector, TlsStream};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use zeroize::Zeroizing;

const MAX_ACCOUNTS: usize = 8;
const CODE_LIFETIME: u64 = 300;
const HISTORY_LIFETIME: u64 = 24 * 60 * 60;
const HISTORY_LIMIT: usize = 5;
const KEYCHAIN_SERVICE: &str = "cn.ac.camellia.flowhub.mail";
const LEGACY_KEYCHAIN_SERVICE: &str = "cn.ac.camellia.flowhub.twofa.mail";

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
enum Provider {
    NetEase,
    Qq,
}

impl Provider {
    fn label(self) -> &'static str {
        match self {
            Self::NetEase => "163 邮箱",
            Self::Qq => "QQ 邮箱",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::NetEase => "imap.163.com",
            Self::Qq => "imap.qq.com",
        }
    }

    fn domain(self) -> &'static str {
        match self {
            Self::NetEase => "163.com",
            Self::Qq => "qq.com",
        }
    }
}

#[derive(Clone, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct Account {
    provider: Provider,
    address: String,
}

impl Account {
    fn parse(params: &Value) -> Result<Self, String> {
        let provider: Provider =
            serde_json::from_value(params["provider"].clone()).map_err(|_| "请选择支持的邮箱")?;
        let address = params["address"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let valid = address.split_once('@').is_some_and(|(name, domain)| {
            !name.is_empty()
                && domain == provider.domain()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
        });
        if !valid || address.len() > 254 {
            return Err(format!("请输入有效的 {} 地址", provider.label()));
        }
        Ok(Self { provider, address })
    }
}

struct Code {
    id: String,
    sender: String,
    received: u64,
    value: Zeroizing<String>,
}

impl Code {
    fn metadata(&self, provider: Provider) -> Value {
        json!({"id":self.id,"type":"twofa","source":"mail","title":self.sender,
            "issuer":format!("{} · 邮件验证码",provider.label()),"description":"邮件验证码",
            "receivedAt":self.received*1000,"expiresAt":(self.received+CODE_LIFETIME)*1000})
    }
}

struct Mailbox {
    status: &'static str,
    codes: VecDeque<Code>,
}

struct Worker {
    state: Arc<Mutex<Mailbox>>,
    _stop: mpsc::Sender<()>,
}

pub struct Monitor {
    file: PathBuf,
    workers: BTreeMap<Account, Worker>,
    credentials: Arc<Mutex<()>>,
    load_error: Option<String>,
}

impl Monitor {
    pub fn new(root: &Path) -> Self {
        let file = root.join("mail-accounts.json");
        let loaded = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice::<Vec<Account>>(&bytes)
                .map_err(|_| "邮箱配置无法读取".to_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err("邮箱配置无法读取".into()),
        };
        let mut this = Self {
            file,
            workers: BTreeMap::new(),
            credentials: Arc::new(Mutex::new(())),
            load_error: None,
        };
        match loaded {
            Ok(accounts) if accounts.len() <= MAX_ACCOUNTS => {
                let normalized = accounts
                    .iter()
                    .map(|account| Account::parse(&json!(account)))
                    .collect::<Result<Vec<_>, _>>();
                match normalized {
                    Ok(accounts) => accounts.into_iter().for_each(|account| this.start(account)),
                    Err(_) => this.load_error = Some("邮箱配置无法读取，请检查配置文件".into()),
                }
            }
            _ => this.load_error = Some("邮箱配置无法读取，请检查配置文件".into()),
        }
        this
    }

    fn start(&mut self, account: Account) {
        let (stop, receiver) = mpsc::channel();
        let state = Arc::new(Mutex::new(Mailbox {
            status: "connecting",
            codes: VecDeque::new(),
        }));
        let worker_state = state.clone();
        let worker_account = account.clone();
        let credentials = self.credentials.clone();
        if thread::Builder::new()
            .name("flowhub-mail".into())
            .spawn(move || monitor_mail(worker_account, worker_state, receiver, credentials))
            .is_err()
        {
            state.lock().unwrap().status = "offline";
        }
        self.workers.insert(account, Worker { state, _stop: stop });
    }

    fn persist(&self, accounts: &[&Account]) -> Result<(), String> {
        let directory = self.file.parent().ok_or("缺少邮箱配置目录")?;
        fs::create_dir_all(directory).map_err(|_| "无法创建邮箱配置目录")?;
        let temp = self
            .file
            .with_extension(format!("{}.tmp", std::process::id()));
        let data = serde_json::to_vec(accounts).map_err(|_| "无法编码邮箱配置")?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|_| "无法创建邮箱配置文件")?;
        let result = file
            .write_all(&data)
            .and_then(|_| file.sync_all())
            .and_then(|_| fs::rename(&temp, &self.file));
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.map_err(|_| "无法保存邮箱配置".into())
    }

    pub fn add(&mut self, mut params: Value) -> Result<Value, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let account = Account::parse(&params)?;
        let Value::String(secret) = params["authorizationCode"].take() else {
            return Err("请输入邮箱生成的客户端授权码".into());
        };
        let secret = Zeroizing::new(secret);
        let secret = secret.trim();
        if secret.is_empty()
            || secret.len() > 128
            || !secret.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err("请输入邮箱生成的客户端授权码".into());
        }
        let existing = self.workers.contains_key(&account);
        if !existing && self.workers.len() >= MAX_ACCOUNTS {
            return Err("最多连接 8 个邮箱".into());
        }
        {
            let _credentials = self.credentials.lock().unwrap();
            keychain::set(&account.address, secret.as_bytes())?;
            if !existing {
                let accounts = self
                    .workers
                    .keys()
                    .chain(std::iter::once(&account))
                    .collect::<Vec<_>>();
                if let Err(error) = self.persist(&accounts) {
                    let _ = keychain::remove(KEYCHAIN_SERVICE, &account.address);
                    return Err(error);
                }
            }
            let _ = keychain::remove(LEGACY_KEYCHAIN_SERVICE, &account.address);
            // Cancel any previous worker before it can write a stale migration.
            self.workers.remove(&account);
        }
        self.start(account);
        Ok(json!({"saved":true}))
    }

    pub fn remove(&mut self, params: &Value) -> Result<Value, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let account = Account::parse(params)?;
        if !self.workers.contains_key(&account) {
            return Err("该邮箱已断开".into());
        }
        let _credentials = self.credentials.lock().unwrap();
        let previous = self.workers.keys().collect::<Vec<_>>();
        let remaining = previous
            .iter()
            .copied()
            .filter(|item| *item != &account)
            .collect::<Vec<_>>();
        self.persist(&remaining)?;
        if let Err(error) = keychain::remove(LEGACY_KEYCHAIN_SERVICE, &account.address)
            .and_then(|()| keychain::remove(KEYCHAIN_SERVICE, &account.address))
        {
            self.persist(&previous)?;
            return Err(error);
        }
        self.workers.remove(&account);
        Ok(json!({"removed":true}))
    }

    pub fn status(&self) -> Result<Value, String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        let accounts = self.workers.iter().map(|(account, worker)| {
            json!({"provider":account.provider,"address":account.address,"status":worker.state.lock().unwrap().status})
        }).collect::<Vec<_>>();
        Ok(json!({"accounts":accounts,"codes":self.search("")}))
    }

    pub fn search(&self, query: &str) -> Vec<Value> {
        let now = now();
        let mail_only = is_mail_only(query);
        let mut entries = Vec::new();
        for (account, worker) in &self.workers {
            let state = worker.state.lock().unwrap();
            entries.extend(
                state
                    .codes
                    .iter()
                    .filter(|code| {
                        fresh(code.received, now) && (mail_only
                            || query.is_empty()
                            || code.sender.to_ascii_lowercase().contains(query)
                            || account.provider.label().to_lowercase().contains(query)
                            || account.address.contains(query))
                    })
                    .map(|code| (code.received, code.metadata(account.provider))),
            );
        }
        entries.sort_by_key(|(received, _)| std::cmp::Reverse(*received));
        entries.into_iter().map(|(_, value)| value).collect()
    }

    pub fn search_accounts(&self, query: &str) -> Vec<Value> {
        let now = now();
        self.workers.iter().filter_map(|(account, worker)| {
            let issuer = account.provider.label();
            let matches_account = query.is_empty() || is_mail_only(query)
                || issuer.to_lowercase().contains(query) || account.address.contains(query);
            let state = worker.state.lock().unwrap();
            let code = state.codes.iter()
                .filter(|code| fresh(code.received, now)
                    && (matches_account || code.sender.to_ascii_lowercase().contains(query)))
                .max_by_key(|code| code.received);
            if !matches_account && code.is_none() {
                return None;
            }
            Some(json!({
                "id": format!("mail-account:{}", account.address),
                "type": "twofa", "source": "mail", "mailAccount": true,
                "title": account.address, "issuer": issuer,
                "mailCodeId": code.map(|code| &code.id),
                "mailHistoryKey": state.codes.iter().rev()
                    .filter(|code| in_history(code.received, now))
                    .take(HISTORY_LIMIT + 1).map(|code| code.id.as_str())
                    .collect::<Vec<_>>().join(":"),
                "receivedAt": code.map(|code| code.received * 1000),
                "expiresAt": code.map(|code| (code.received + CODE_LIFETIME) * 1000)
            }))
        }).collect()
    }

    pub fn history(&self, account_id: &str, current_id: Option<&str>) -> Result<Value, String> {
        let address = account_id.strip_prefix("mail-account:").ok_or("邮箱不可用")?;
        let worker = self.workers.iter().find_map(|(account, worker)| {
            (account.address == address).then_some(worker)
        }).ok_or("邮箱不可用")?;
        let now = now();
        let state = worker.state.lock().unwrap();
        let history = state.codes.iter().rev()
            .filter(|code| Some(code.id.as_str()) != current_id && in_history(code.received, now))
            .take(HISTORY_LIMIT)
            .map(|code| json!({
                "id": code.id,
                "code": code.value.as_str(),
                "sender": code.sender,
                "receivedAt": code.received * 1000,
                "historyUntil": (code.received + HISTORY_LIFETIME) * 1000
            }))
            .collect::<Vec<_>>();
        Ok(json!(history))
    }

    pub fn code(&self, id: &str) -> Result<(String, u64), String> {
        for worker in self.workers.values() {
            let state = worker.state.lock().unwrap();
            if let Some(code) = state
                .codes
                .iter()
                .find(|code| code.id == id && fresh(code.received, now()))
            {
                return Ok((code.value.to_string(), (code.received + CODE_LIFETIME) * 1000));
            }
        }
        Err("验证码已过期，请刷新后重试".into())
    }
}

pub(super) fn is_mail_only(query: &str) -> bool {
    matches!(query, "邮件验证码" | "邮箱验证码")
}

fn fresh(received: u64, now: u64) -> bool {
    received <= now && now - received < CODE_LIFETIME
}

fn in_history(received: u64, now: u64) -> bool {
    received <= now && now - received < HISTORY_LIFETIME
}

fn extract_code(raw: &[u8]) -> Option<(String, Zeroizing<String>)> {
    static CONTEXT_CODE: OnceLock<Regex> = OnceLock::new();
    let pattern = CONTEXT_CODE.get_or_init(|| {
        Regex::new(concat!(
            r"(?i)(?:验证码|校验码|动态码|安全代码|verification\s+code|security\s+code|",
            r"one[- ]time\s+(?:code|passcode|password)|sign[- ]in\s+code|login\s+code)",
            r"\s*(?:是|为|is\b)?\s*[:：]?\s*([0-9]{4,8})"
        ))
        .unwrap()
    });
    let parser = MessageParser::default();
    let mail = parser.parse(raw)?;
    let sender = mail.from()?.first()?.address()?;
    let domain = sender.rsplit_once('@')?.1.to_ascii_lowercase();
    if !domain.contains('.')
        || domain.len() > 120
        || !domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    {
        return None;
    }
    let body = mail.body_text(0);
    let fields = [mail.subject().unwrap_or(""), body.as_deref().unwrap_or("")];
    let mut value: Option<Zeroizing<String>> = None;
    for field in fields {
        for capture in pattern.captures_iter(field) {
            let digits = capture.get(1)?;
            if field
                .as_bytes()
                .get(digits.end())
                .is_some_and(u8::is_ascii_alphanumeric)
            {
                continue;
            }
            let current = digits.as_str();
            if value.as_deref().is_some_and(|previous| previous != current) {
                return None;
            }
            value = Some(Zeroizing::new(current.to_owned()));
        }
        if value.is_none()
            && field.trim().bytes().all(|b| b.is_ascii_digit())
            && (4..=8).contains(&field.trim().len())
            && mail.subject().is_some_and(|subject| {
                subject.contains("验证码")
                    || subject.to_ascii_lowercase().contains("verification code")
            })
        {
            value = Some(Zeroizing::new(field.trim().to_owned()));
        }
    }
    Some((domain, value?))
}

const SOCKET_TIMEOUT: Duration = Duration::from_secs(12);

struct MailStream(TlsStream<TcpStream>);

impl Read for MailStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for MailStream {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl imap::extensions::idle::SetReadTimeout for MailStream {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> imap::error::Result<()> {
        // The IMAP library clears the temporary IDLE timeout before sending DONE.
        self.0
            .get_ref()
            .set_read_timeout(Some(timeout.unwrap_or(SOCKET_TIMEOUT)))
            .map_err(imap::error::Error::Io)
    }
}

fn connect(account: &Account, secret: &str) -> Result<(Session<MailStream>, bool), &'static str> {
    let domain = account.provider.endpoint();
    let addresses = (domain, 993).to_socket_addrs().map_err(|_| "offline")?;
    let stream = addresses
        .take(4)
        .find_map(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(4)).ok())
        .ok_or("offline")?;
    let timeout = Some(SOCKET_TIMEOUT);
    stream.set_read_timeout(timeout).map_err(|_| "offline")?;
    stream.set_write_timeout(timeout).map_err(|_| "offline")?;
    let tls = TlsConnector::new().map_err(|_| "offline")?;
    let stream = tls.connect(domain, stream).map_err(|_| "offline")?;
    let mut client = Client::new(MailStream(stream));
    client.read_greeting().map_err(|_| "offline")?;
    let mut session = client
        .login(&account.address, secret)
        .map_err(|(error, _)| match error {
            imap::error::Error::No(_) | imap::error::Error::Bad(_) => "authorization",
            _ => "offline",
        })?;
    let idle = configure_session(&mut session).map_err(|_| "offline")?;
    Ok((session, idle))
}

fn configure_session<T: Read + Write>(session: &mut Session<T>) -> imap::error::Result<bool> {
    let capabilities = session.capabilities()?;
    let identify = capabilities.has_str("ID");
    let idle = capabilities.has_str("IDLE");
    drop(capabilities);
    if identify {
        match session.run_command_and_check_ok(concat!(
            "ID (\"name\" \"FlowHub\" \"version\" \"",
            env!("CARGO_PKG_VERSION"),
            "\")"
        )) {
            Ok(()) | Err(imap::error::Error::Bad(_) | imap::error::Error::No(_)) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(idle)
}

#[derive(Default)]
struct Cursor {
    validity: Option<u32>,
    uid: u32,
}

fn collect<T: Read + Write>(
    session: &mut Session<T>,
    state: &Mutex<Mailbox>,
    cursor: &mut Cursor,
    now: u64,
) -> imap::error::Result<()> {
    let inbox = session.examine("INBOX")?;
    if inbox.uid_validity != cursor.validity {
        *cursor = Cursor {
            validity: inbox.uid_validity,
            uid: 0,
        };
    }
    if inbox.exists == 0
        || inbox
            .uid_next
            .is_some_and(|next| next <= cursor.uid.saturating_add(1))
    {
        return Ok(());
    }
    let range = format!(
        "{}:{}",
        inbox.exists.saturating_sub(63).max(1),
        inbox.exists
    );
    let headers = session.fetch(range, "(UID INTERNALDATE)")?;
    let uids = headers
        .iter()
        .filter_map(|row| {
            let uid = row.uid?;
            let received = u64::try_from(row.internal_date()?.timestamp()).ok()?;
            (uid > cursor.uid && in_history(received, now)).then_some(uid)
        })
        .collect::<Vec<_>>();
    if !uids.is_empty() {
        let uid_set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let messages = session.uid_fetch(uid_set, "(UID INTERNALDATE BODY.PEEK[]<0.65536>)")?;
        let mut new_codes = Vec::new();
        for row in messages.iter() {
            let Some(received) = row
                .internal_date()
                .and_then(|date| u64::try_from(date.timestamp()).ok())
            else {
                continue;
            };
            if !in_history(received, now) {
                continue;
            }
            let Some((sender, value)) = row.body().and_then(extract_code) else {
                continue;
            };
            let mut id = [0u8; 16];
            use ring::rand::SecureRandom;
            if ring::rand::SystemRandom::new().fill(&mut id).is_err() {
                continue;
            }
            use base64::Engine;
            new_codes.push(Code {
                id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id),
                sender,
                received,
                value,
            });
        }
        let mut state = state.lock().unwrap();
        state.codes.retain(|code| in_history(code.received, now));
        state.codes.extend(new_codes);
        state
            .codes
            .make_contiguous()
            .sort_by_key(|code| code.received);
        while state.codes.len() > 20 {
            state.codes.pop_front();
        }
    }
    cursor.uid = headers
        .iter()
        .filter_map(|row| row.uid)
        .max()
        .unwrap_or(cursor.uid)
        .max(cursor.uid);
    Ok(())
}

fn authorization(
    address: &str,
    stop: &mpsc::Receiver<()>,
    credentials: &Mutex<()>,
) -> Result<Zeroizing<String>, String> {
    if let Some(secret) = keychain::get(KEYCHAIN_SERVICE, address)? {
        return Ok(secret);
    }
    // The old item can need one-time permission. Do not hold the mutation lock
    // while macOS is waiting, and never migrate after replacement or removal.
    let legacy = keychain::get(LEGACY_KEYCHAIN_SERVICE, address)?
        .ok_or("邮箱授权码不存在")?;
    let _credentials = credentials.lock().unwrap();
    if !matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
        return Err("邮箱连接已变更".into());
    }
    if let Some(secret) = keychain::get(KEYCHAIN_SERVICE, address)? {
        return Ok(secret);
    }
    keychain::set(address, legacy.as_bytes())?;
    let _ = keychain::remove(LEGACY_KEYCHAIN_SERVICE, address);
    Ok(legacy)
}

fn monitor_mail(
    account: Account,
    state: Arc<Mutex<Mailbox>>,
    stop: mpsc::Receiver<()>,
    credentials: Arc<Mutex<()>>,
) {
    let Ok(secret) = authorization(&account.address, &stop, &credentials) else {
        state.lock().unwrap().status = "authorization";
        return;
    };
    let mut cursor = Cursor::default();
    let mut backoff = 2;
    while matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
        match connect(&account, &secret) {
            Ok((mut session, mut idle)) => {
                while matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                    if let Err(error) = collect(&mut session, &state, &mut cursor, now()) {
                        if matches!(error, imap::error::Error::No(_)) {
                            state.lock().unwrap().status = "authorization";
                            return;
                        }
                        break;
                    }
                    {
                        let mut state = state.lock().unwrap();
                        state.status = if idle { "live" } else { "polling" };
                        state
                            .codes
                            .retain(|code| in_history(code.received, now()));
                    }
                    backoff = 2;
                    if idle {
                        let outcome = session.idle().timeout(Duration::from_secs(25))
                            .keepalive(false).wait_while(|_| false);
                        match outcome {
                            Ok(_) => {}
                            Err(imap::error::Error::Bad(_) | imap::error::Error::No(_)) => {
                                idle = false
                            }
                            Err(_) => break,
                        }
                    } else if !matches!(
                        stop.recv_timeout(Duration::from_secs(8)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        return;
                    }
                }
            }
            Err("authorization") => {
                state.lock().unwrap().status = "authorization";
                return;
            }
            Err(_) => {}
        }
        state.lock().unwrap().status = "offline";
        if !matches!(
            stop.recv_timeout(Duration::from_secs(backoff)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            return;
        }
        backoff = (backoff * 2).min(60);
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::{Zeroizing, KEYCHAIN_SERVICE};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub fn get(service: &str, address: &str) -> Result<Option<Zeroizing<String>>, String> {
        let bytes = Zeroizing::new(match get_generic_password(service, address) {
            Ok(bytes) => bytes,
            Err(error) if error.code() == -25300 => return Ok(None),
            Err(_) => return Err("无法读取钥匙串授权码".into()),
        });
        let secret = std::str::from_utf8(&bytes).map_err(|_| "授权码格式无效")?;
        Ok(Some(Zeroizing::new(secret.to_owned())))
    }

    pub fn set(address: &str, secret: &[u8]) -> Result<(), String> {
        set_generic_password(KEYCHAIN_SERVICE, address, secret)
            .map_err(|_| "无法保存授权码到钥匙串".into())
    }

    pub fn remove(service: &str, address: &str) -> Result<(), String> {
        match delete_generic_password(service, address) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(_) => Err("无法从钥匙串删除授权码".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        os::unix::net::UnixStream,
    };

    #[test]
    fn launcher_mail_account_keeps_its_identity_and_only_exposes_fresh_code_metadata() {
        let now = now();
        let account = Account { provider: Provider::NetEase, address: "fixture@163.com".into() };
        let state = Arc::new(Mutex::new(Mailbox { status: "live", codes: VecDeque::new() }));
        let (stop, _) = mpsc::channel();
        let monitor = Monitor {
            file: PathBuf::new(), credentials: Arc::new(Mutex::new(())), load_error: None,
            workers: BTreeMap::from([(account, Worker { state: state.clone(), _stop: stop })]),
        };
        let waiting = monitor.search_accounts("163");
        assert_eq!(waiting.len(), 1);
        assert!(waiting[0]["mailCodeId"].is_null());
        assert!(monitor.search("").is_empty());
        let code = |id: &str, received| Code {
            id: id.into(), sender: "example.test".into(), received, value: Zeroizing::new("713049".into()),
        };
        state.lock().unwrap().codes.extend([
            code("expired", now - CODE_LIFETIME), code("older", now - 2), code("latest", now - 1),
        ]);
        let received = monitor.search_accounts("example.test");
        assert_eq!(received.len(), 1);
        assert_eq!(received[0]["id"], waiting[0]["id"]);
        assert_eq!(received[0]["mailCodeId"], "latest");
        assert_eq!(monitor.code("latest").unwrap().0, "713049");
        assert!(!received[0].to_string().contains("713049"));
        let account_id = waiting[0]["id"].as_str().unwrap();
        let history = monitor.history(account_id, Some("latest")).unwrap();
        assert_eq!(history.as_array().unwrap().len(), 2);
        assert_eq!(history[0]["id"], "older");
        assert_eq!(history[1]["id"], "expired");
        assert_eq!(history[1]["code"], "713049");
        assert!(monitor.code("expired").is_err());
        assert!(monitor.history("mail-account:another@163.com", None).is_err());
        state.lock().unwrap().codes.retain(|code| code.id == "expired");
        let expired = monitor.search_accounts("163");
        assert_eq!(expired[0]["id"], waiting[0]["id"]);
        assert!(expired[0]["mailCodeId"].is_null());
        assert!(monitor.search("").is_empty());
        assert_eq!(monitor.history(account_id, None).unwrap()[0]["id"], "expired");
    }

    #[test]
    fn recognizes_contextual_codes_and_rejects_ambiguous_messages() {
        let parse = |body: &str| {
            let raw = format!("From: Sender <notice@example.test>\r\nSubject: Login\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}");
            extract_code(raw.as_bytes())
        };
        let (sender, code) = parse("您的验证码为：018295").unwrap();
        assert_eq!(sender, "example.test");
        assert_eq!(code.as_str(), "018295");
        assert_eq!(
            parse("Your verification code is 321456")
                .unwrap()
                .1
                .as_str(),
            "321456"
        );
        assert!(parse("Order number 123456").is_none());
        assert!(parse("Verification code 123456. Security code 234567.").is_none());
        assert!(parse("验证码 123456789").is_none());
        assert!(fresh(1000, 1299) && !fresh(1000, 1300));
    }

    #[test]
    fn collects_only_recent_messages_via_read_only_imap_and_deduplicates_uids() {
        let (client, mut server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let endpoint = thread::spawn(move || {
            let mut input = BufReader::new(server.try_clone().unwrap());
            let mut command = String::new();
            let raw = "From: Notice <notice@example.test>\r\nSubject: Sign in\r\n\r\nYour login code is 013489";
            for (expected, reply) in [
                ("LOGIN", String::new()),
                ("CAPABILITY", "* CAPABILITY IMAP4rev1 ID IDLE\r\n".into()),
                ("ID (\"name\" \"FlowHub\"", "* ID (\"name\" \"Coremail\" \"version\" \"fixture\")\r\n".into()),
                ("EXAMINE", "* 2 EXISTS\r\n* OK [UIDVALIDITY 99] valid\r\n* OK [UIDNEXT 22] next\r\n".into()),
                ("FETCH 1:2 (UID INTERNALDATE)", "* 1 FETCH (UID 20 INTERNALDATE \"13-Nov-2023 21:13:20 +0000\")\r\n* 2 FETCH (UID 21 INTERNALDATE \"14-Nov-2023 22:13:20 +0000\")\r\n".into()),
                ("UID FETCH 21 (UID INTERNALDATE BODY.PEEK[]<0.65536>)", format!("* 2 FETCH (UID 21 INTERNALDATE \"14-Nov-2023 22:13:20 +0000\" BODY[]<0> {{{}}}\r\n{raw})\r\n",raw.len())),
                ("EXAMINE", "* 2 EXISTS\r\n* OK [UIDVALIDITY 99] valid\r\n* OK [UIDNEXT 22] next\r\n".into()),
            ] {
                command.clear();
                assert!(input.read_line(&mut command).unwrap() > 0);
                let (tag, request) = command.split_once(' ').unwrap();
                assert!(request.starts_with(expected), "unexpected IMAP command");
                write!(server,"{reply}{tag} OK done\r\n").unwrap();
            }
        });
        let mut session = Client::new(client)
            .login("fixture", "fixture")
            .ok()
            .unwrap();
        assert!(configure_session(&mut session).unwrap());
        let state = Mutex::new(Mailbox {
            status: "live",
            codes: VecDeque::new(),
        });
        let mut cursor = Cursor::default();
        collect(&mut session, &state, &mut cursor, 1_700_000_020).unwrap();
        collect(&mut session, &state, &mut cursor, 1_700_000_020).unwrap();
        endpoint.join().unwrap();
        let state = state.lock().unwrap();
        assert_eq!(state.codes.len(), 1);
        let code = &state.codes[0];
        assert_eq!(code.value.as_str(), "013489");
        assert!(!code
            .metadata(Provider::NetEase)
            .to_string()
            .contains("013489"));
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use super::Zeroizing;
    pub fn get(_: &str, _: &str) -> Result<Option<Zeroizing<String>>, String> {
        Err("邮箱授权仅支持 macOS".into())
    }
    pub fn set(_: &str, _: &[u8]) -> Result<(), String> {
        Err("邮箱授权仅支持 macOS".into())
    }
    pub fn remove(_: &str, _: &str) -> Result<(), String> {
        Err("邮箱授权仅支持 macOS".into())
    }
}
