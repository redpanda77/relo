// Port of VoiceModelStore.swift: the Relo voice's files, one pinned Hugging Face revision, each file checked against its
// SHA-256, so what runs is what was reviewed. Downloaded by the app itself into %LOCALAPPDATA%\Relo\voice, on its own when
// the connection is not metered, or when the owner asks. Resumable: a dropped download keeps its `.part` file and the next
// attempt asks the server for the rest (HTTP Range).
//
// The revision is the Mac's (541f5752bc3c...). The Mac loads the same checkpoint through MLX and reads `tokenizer.model`
// (SentencePiece); Gradium's Rust runtime reads `tokenizer.json` of the same revision instead (Gradium's own conversion of
// that tokenizer), so that file replaces it. config.json, default-voice.safetensors and model.safetensors are byte-identical
// to the Mac's (same SHA-256).

use super::network::{Network, NetworkProbe};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct ModelFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug)]
pub struct VoiceModel {
    pub id: String,
    pub repo: String,
    pub revision: String,
    pub files: Vec<ModelFile>,
    /// Where `resolve/<revision>/<file>` lives; tests point it at a local server.
    pub base_url: String,
}

impl VoiceModel {
    pub fn phonon_31m_en() -> Self {
        let f = |name: &str, bytes: u64, sha256: &str| ModelFile { name: name.into(), bytes, sha256: sha256.into() };
        Self {
            id: "phonon-31m-en".into(),
            repo: "gradium/phonon-31m-en".into(),
            revision: "541f5752bc3c79583068bb205bfda5eb39aaa08a".into(),
            files: vec![
                f("config.json", 4_634, "b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85"),
                // Not on the Mac (it reads tokenizer.model); the runtime Windows uses reads this one.
                f("tokenizer.json", 277_967, "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936"),
                f("default-voice.safetensors", 256_136, "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18"),
                f("model.safetensors", 102_823_920, "8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607"),
            ],
            base_url: "https://huggingface.co".into(),
        }
    }

    pub fn bytes(&self) -> u64 {
        self.files.iter().map(|f| f.bytes).sum()
    }

    pub fn url(&self, file: &ModelFile) -> String {
        format!("{}/{}/resolve/{}/{}", self.base_url, self.repo, self.revision, file.name)
    }

    /// `phonon-31m-en-541f5752bc3c`, as on the Mac.
    pub fn directory_name(&self) -> String {
        format!("{}-{}", self.id, &self.revision[..self.revision.len().min(12)])
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
    Download(String),
    Checksum(String),
    Io(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Download(n) => write!(f, "Could not download {n}"),
            StoreError::Checksum(n) => write!(f, "{n} did not match its checksum"),
            StoreError::Io(m) => write!(f, "{m}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StateKind {
    Missing,
    Downloading,
    Ready,
    Failed,
}

/// What the page sees (events `voice_progress`, command `voice_status`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub state: StateKind,
    /// 0...1 while downloading.
    pub fraction: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    /// Waiting for a connection that is not metered to download on its own.
    pub waiting_for_network: bool,
    pub id: String,
    pub revision: String,
    pub directory: String,
}

struct Inner {
    state: StateKind,
    downloaded: u64,
    error: Option<String>,
    waiting: bool,
    /// The running download (or the unmetered wait): cancelled by `cancel` and `delete`.
    cancel: Option<Arc<AtomicBool>>,
    handle: Option<JoinHandle<()>>,
}

type OnChange = Arc<dyn Fn(ModelStatus) + Send + Sync>;
type OnReady = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct VoiceModelStore {
    model: Arc<VoiceModel>,
    dir: Arc<PathBuf>,
    inner: Arc<Mutex<Inner>>,
    net: Arc<dyn NetworkProbe>,
    on_change: OnChange,
    on_ready: Arc<Mutex<Option<OnReady>>>,
    poll: Duration,
}

impl VoiceModelStore {
    pub fn new(model: VoiceModel, root: PathBuf, net: Arc<dyn NetworkProbe>, on_change: OnChange) -> Self {
        let dir = root.join(model.directory_name());
        let store = Self {
            model: Arc::new(model),
            dir: Arc::new(dir),
            inner: Arc::new(Mutex::new(Inner {
                state: StateKind::Missing,
                downloaded: 0,
                error: None,
                waiting: false,
                cancel: None,
                handle: None,
            })),
            net,
            on_change,
            on_ready: Arc::new(Mutex::new(None)),
            poll: Duration::from_secs(20),
        };
        if store.is_complete() {
            store.inner.lock().unwrap().state = StateKind::Ready;
        }
        store
    }

    /// How often the unmetered wait looks at the connection (tests make it short).
    pub fn with_poll(mut self, poll: Duration) -> Self {
        self.poll = poll;
        self
    }

    /// `%LOCALAPPDATA%\Relo\voice`.
    pub fn default_root() -> PathBuf {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        base.join("Relo").join("voice")
    }

    pub fn model(&self) -> &VoiceModel {
        &self.model
    }

    pub fn directory(&self) -> PathBuf {
        (*self.dir).clone()
    }

    pub fn set_on_ready(&self, f: OnReady) {
        *self.on_ready.lock().unwrap() = Some(f);
    }

    /// Every pinned file is in place (each was verified before it was moved there).
    pub fn is_complete(&self) -> bool {
        self.model
            .files
            .iter()
            .all(|f| fs::metadata(self.dir.join(&f.name)).map(|m| m.is_file() && m.len() == f.bytes).unwrap_or(false))
    }

    pub fn is_ready(&self) -> bool {
        self.inner.lock().unwrap().state == StateKind::Ready
    }

    pub fn status(&self) -> ModelStatus {
        let i = self.inner.lock().unwrap();
        self.snapshot(&i)
    }

    fn snapshot(&self, i: &Inner) -> ModelStatus {
        let total = self.model.bytes();
        ModelStatus {
            state: i.state,
            fraction: match i.state {
                StateKind::Ready => 1.0,
                StateKind::Downloading => {
                    if total == 0 {
                        0.0
                    } else {
                        (i.downloaded as f64 / total as f64).min(1.0)
                    }
                }
                _ => 0.0,
            },
            downloaded_bytes: if i.state == StateKind::Ready { total } else { i.downloaded },
            total_bytes: total,
            error: i.error.clone(),
            waiting_for_network: i.waiting,
            id: self.model.id.clone(),
            revision: self.model.revision.clone(),
            directory: self.dir.display().to_string(),
        }
    }

    fn emit(&self) {
        (self.on_change)(self.status());
    }

    /// Downloads once the connection is not metered; a hotspot or a data-limited plan waits for a better one.
    pub fn download_when_unmetered(&self) {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut i = self.inner.lock().unwrap();
            if i.cancel.is_some() || i.state == StateKind::Ready {
                return;
            }
            i.waiting = true;
            i.cancel = Some(cancel.clone());
        }
        self.emit();
        let store = self.clone();
        let handle = std::thread::Builder::new()
            .name("relo-voice-wait".into())
            .spawn(move || {
                while !cancel.load(Ordering::SeqCst) {
                    if store.net.status() == Network::Unmetered {
                        // Hand over to the download proper (it takes the cancel slot again).
                        {
                            let mut i = store.inner.lock().unwrap();
                            if cancel.load(Ordering::SeqCst) {
                                return;
                            }
                            i.waiting = false;
                            i.cancel = None;
                            i.handle = None;
                        }
                        store.download();
                        return;
                    }
                    std::thread::sleep(store.poll);
                }
            })
            .ok();
        self.inner.lock().unwrap().handle = handle;
    }

    /// Downloads now (the owner asked), whatever the connection.
    pub fn download(&self) {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut i = self.inner.lock().unwrap();
            // The unmetered wait gives way to an explicit download; a running download is left alone.
            if i.state == StateKind::Ready || (i.cancel.is_some() && !i.waiting) {
                return;
            }
            if let Some(old) = i.cancel.take() {
                old.store(true, Ordering::SeqCst);
            }
            i.waiting = false;
            i.state = StateKind::Downloading;
            i.error = None;
            i.downloaded = 0;
            i.cancel = Some(cancel.clone());
        }
        self.emit();
        let store = self.clone();
        let handle = std::thread::Builder::new()
            .name("relo-voice-download".into())
            .spawn(move || {
                let outcome = store.fetch_all(&cancel);
                let mut ready = false;
                {
                    let mut i = store.inner.lock().unwrap();
                    // A newer job (or a delete) owns the slot now: this one just ends.
                    if cancel.load(Ordering::SeqCst) {
                        if i.cancel.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
                            i.cancel = None;
                            i.state = StateKind::Missing;
                            i.downloaded = 0;
                        }
                    } else {
                        i.cancel = None;
                        match outcome {
                            Ok(()) => {
                                i.state = StateKind::Ready;
                                i.error = None;
                                ready = true;
                            }
                            Err(e) => {
                                i.state = StateKind::Failed;
                                i.error = Some(e.to_string());
                            }
                        }
                    }
                }
                store.emit();
                if ready {
                    let f = store.on_ready.lock().unwrap().clone();
                    if let Some(f) = f {
                        f();
                    }
                }
            })
            .ok();
        self.inner.lock().unwrap().handle = handle;
    }

    /// Stops a download or the unmetered wait; the partial file stays for the next attempt.
    pub fn cancel(&self) {
        {
            let mut i = self.inner.lock().unwrap();
            if let Some(c) = i.cancel.take() {
                c.store(true, Ordering::SeqCst);
            }
            i.waiting = false;
            if i.state == StateKind::Downloading {
                i.state = StateKind::Missing;
                i.downloaded = 0;
            }
        }
        self.emit();
    }

    /// Deletes the voice's files (partial ones too).
    pub fn delete(&self) {
        let handle = {
            let mut i = self.inner.lock().unwrap();
            if let Some(c) = i.cancel.take() {
                c.store(true, Ordering::SeqCst);
            }
            i.waiting = false;
            i.handle.take()
        };
        if let Some(h) = handle {
            let _ = h.join();
        }
        let _ = fs::remove_dir_all(&*self.dir);
        {
            let mut i = self.inner.lock().unwrap();
            i.state = StateKind::Missing;
            i.downloaded = 0;
            i.error = None;
        }
        self.emit();
    }

    fn progress(&self, downloaded: u64, last: &mut Instant, force: bool) {
        self.inner.lock().unwrap().downloaded = downloaded;
        if force || last.elapsed() >= Duration::from_millis(150) {
            *last = Instant::now();
            self.emit();
        }
    }

    fn fetch_all(&self, cancel: &AtomicBool) -> Result<(), StoreError> {
        fs::create_dir_all(&*self.dir).map_err(|e| StoreError::Io(format!("Could not create the voice folder: {e}")))?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60 * 60)))
            .build()
            .into();
        let mut done: u64 = 0;
        let mut last = Instant::now();
        for file in &self.model.files {
            let target = self.dir.join(&file.name);
            let present = fs::metadata(&target).map(|m| m.len() == file.bytes).unwrap_or(false);
            if !present {
                self.fetch_file(&agent, file, &target, done, cancel, &mut last)?;
            }
            done += file.bytes;
            self.progress(done, &mut last, true);
        }
        Ok(())
    }

    fn fetch_file(
        &self,
        agent: &ureq::Agent,
        file: &ModelFile,
        target: &Path,
        done: u64,
        cancel: &AtomicBool,
        last: &mut Instant,
    ) -> Result<(), StoreError> {
        let part = self.dir.join(format!("{}.part", file.name));
        let io = |e: std::io::Error| StoreError::Io(format!("{}: {e}", file.name));
        let mut have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if have > file.bytes {
            let _ = fs::remove_file(&part);
            have = 0;
        }
        if have < file.bytes {
            let url = self.model.url(file);
            let mut attempt = 0;
            loop {
                attempt += 1;
                let mut request = agent.get(&url);
                if have > 0 {
                    request = request.header("Range", format!("bytes={have}-"));
                }
                let mut response = request.call().map_err(|_| StoreError::Download(file.name.clone()))?;
                let status = response.status().as_u16();
                let append = match status {
                    206 => true,
                    200 => false, // the server ignored the range: start over
                    416 if attempt == 1 => {
                        // Our partial file is not something the server can continue.
                        let _ = fs::remove_file(&part);
                        have = 0;
                        continue;
                    }
                    _ => return Err(StoreError::Download(file.name.clone())),
                };
                let mut out = if append && have > 0 {
                    fs::OpenOptions::new().append(true).open(&part).map_err(io)?
                } else {
                    have = 0;
                    fs::File::create(&part).map_err(io)?
                };
                let mut reader = response.body_mut().as_reader();
                let mut buf = vec![0u8; 64 * 1024];
                let mut written = have;
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(StoreError::Download(file.name.clone()));
                    }
                    let n = match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        // The connection dropped: the partial file stays, the next attempt resumes it.
                        Err(_) => {
                            let _ = out.flush();
                            return Err(StoreError::Download(file.name.clone()));
                        }
                    };
                    out.write_all(&buf[..n]).map_err(io)?;
                    written += n as u64;
                    self.progress(done + written.min(file.bytes), last, false);
                    if written > file.bytes {
                        break;
                    }
                }
                out.flush().map_err(io)?;
                drop(out);
                break;
            }
        }
        let len = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if len != file.bytes {
            // Too short: keep it to resume. Too long: it is not this file.
            if len > file.bytes {
                let _ = fs::remove_file(&part);
            }
            return Err(StoreError::Download(file.name.clone()));
        }
        if sha256_of(&part).map_err(io)? != file.sha256 {
            let _ = fs::remove_file(&part);
            return Err(StoreError::Checksum(file.name.clone()));
        }
        let _ = fs::remove_file(target);
        fs::rename(&part, target).map_err(io)
    }
}

pub fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::AtomicUsize;

    /// A local HTTP server that serves files with Range support, and can drop a connection part-way.
    struct Fake {
        base: String,
        ranges: Arc<Mutex<Vec<Option<String>>>>,
        /// Cut the next response after this many body bytes (then close), once.
        cut_after: Arc<Mutex<Option<usize>>>,
        ignore_range: Arc<AtomicBool>,
        hits: Arc<AtomicUsize>,
    }

    fn serve(files: HashMap<String, Vec<u8>>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let fake = Fake {
            base,
            ranges: Arc::default(),
            cut_after: Arc::default(),
            ignore_range: Arc::default(),
            hits: Arc::default(),
        };
        let (ranges, cut, ignore, hits) =
            (fake.ranges.clone(), fake.cut_after.clone(), fake.ignore_range.clone(), fake.hits.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (files, ranges, cut, ignore, hits) =
                    (files.clone(), ranges.clone(), cut.clone(), ignore.clone(), hits.clone());
                std::thread::spawn(move || handle(stream, &files, &ranges, &cut, &ignore, &hits));
            }
        });
        fake
    }

    fn handle(
        mut stream: TcpStream,
        files: &HashMap<String, Vec<u8>>,
        ranges: &Mutex<Vec<Option<String>>>,
        cut: &Mutex<Option<usize>>,
        ignore: &AtomicBool,
        hits: &AtomicUsize,
    ) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
        let mut range = None;
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).unwrap();
            if h.trim().is_empty() {
                break;
            }
            if let Some(v) = h.to_ascii_lowercase().strip_prefix("range:") {
                range = Some(v.trim().to_string());
            }
        }
        hits.fetch_add(1, Ordering::SeqCst);
        ranges.lock().unwrap().push(range.clone());
        let name = path.rsplit('/').next().unwrap();
        let Some(body) = files.get(name) else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        };
        let start = match (&range, ignore.load(Ordering::SeqCst)) {
            (Some(r), false) => r.trim_start_matches("bytes=").trim_end_matches('-').parse::<usize>().unwrap_or(0),
            _ => 0,
        };
        let part = &body[start..];
        let head = if start > 0 {
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                part.len(),
                start,
                body.len() - 1,
                body.len()
            )
        } else {
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", part.len())
        };
        let _ = stream.write_all(head.as_bytes());
        let limit = cut.lock().unwrap().take();
        match limit {
            Some(n) => {
                let _ = stream.write_all(&part[..n.min(part.len())]);
                let _ = stream.flush();
            }
            None => {
                let _ = stream.write_all(part);
            }
        }
    }

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn payload(seed: u8, len: usize) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    struct Fixed(Mutex<Network>);
    impl NetworkProbe for Fixed {
        fn status(&self) -> Network {
            *self.0.lock().unwrap()
        }
    }

    struct Rig {
        store: VoiceModelStore,
        fake: Fake,
        files: Vec<(String, Vec<u8>)>,
        root: PathBuf,
        events: Arc<Mutex<Vec<ModelStatus>>>,
        net: Arc<Fixed>,
    }

    fn rig(tag: &str, network: Network, corrupt_second: bool) -> Rig {
        let a = payload(1, 300_000);
        let b = payload(7, 150_000);
        let mut served = HashMap::new();
        served.insert("a.bin".to_string(), a.clone());
        served.insert("b.bin".to_string(), b.clone());
        let fake = serve(served);
        let model = VoiceModel {
            id: "test-voice".into(),
            repo: "owner/test-voice".into(),
            revision: "0123456789abcdef".into(),
            files: vec![
                ModelFile { name: "a.bin".into(), bytes: a.len() as u64, sha256: sha(&a) },
                ModelFile {
                    name: "b.bin".into(),
                    bytes: b.len() as u64,
                    sha256: if corrupt_second { "0".repeat(64) } else { sha(&b) },
                },
            ],
            base_url: fake.base.clone(),
        };
        let root = std::env::temp_dir().join(format!("relo-voice-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let events: Arc<Mutex<Vec<ModelStatus>>> = Arc::default();
        let sink = events.clone();
        let net = Arc::new(Fixed(Mutex::new(network)));
        let store = VoiceModelStore::new(model, root.clone(), net.clone(), Arc::new(move |s| sink.lock().unwrap().push(s)))
            .with_poll(Duration::from_millis(10));
        Rig { store, fake, files: vec![("a.bin".into(), a), ("b.bin".into(), b)], root, events, net }
    }

    fn wait_for(store: &VoiceModelStore, done: impl Fn(StateKind) -> bool) -> ModelStatus {
        for _ in 0..1000 {
            let s = store.status();
            if done(s.state) && !s.waiting_for_network {
                return s;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out in {:?}", store.status());
    }

    #[test]
    fn the_pinned_model_is_the_macs_revision_and_hashes() {
        let m = VoiceModel::phonon_31m_en();
        assert_eq!(m.directory_name(), "phonon-31m-en-541f5752bc3c");
        assert_eq!(
            m.url(&m.files[3]),
            "https://huggingface.co/gradium/phonon-31m-en/resolve/541f5752bc3c79583068bb205bfda5eb39aaa08a/model.safetensors"
        );
        // VoiceModelStore.swift's own hashes for the files both platforms load.
        let sha = |n: &str| m.files.iter().find(|f| f.name == n).unwrap().sha256.clone();
        assert_eq!(sha("model.safetensors"), "8a04cf833cfe69b67c2ec968b2d31244655b9accc84ade9c0ebcc176f2074607");
        assert_eq!(sha("default-voice.safetensors"), "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18");
        assert_eq!(sha("config.json"), "b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85");
    }

    #[test]
    fn downloads_verifies_and_reports_progress() {
        let r = rig("ok", Network::Unmetered, false);
        let ready = Arc::new(AtomicBool::new(false));
        let flag = ready.clone();
        r.store.set_on_ready(Arc::new(move || flag.store(true, Ordering::SeqCst)));
        r.store.download();
        let s = wait_for(&r.store, |k| k == StateKind::Ready);
        assert_eq!(s.fraction, 1.0);
        for (name, bytes) in &r.files {
            assert_eq!(&fs::read(r.store.directory().join(name)).unwrap(), bytes);
            assert!(!r.store.directory().join(format!("{name}.part")).exists());
        }
        assert!(ready.load(Ordering::SeqCst));
        let fractions: Vec<f64> = r.events.lock().unwrap().iter().map(|e| e.fraction).collect();
        assert!(fractions.windows(2).all(|w| w[0] <= w[1] + 1e-9), "{fractions:?}");
        assert!(r.store.is_complete());
        // A second store over the same folder starts ready (the app restarted).
        let again = VoiceModelStore::new(r.store.model().clone(), r.root.clone(), r.net.clone(), Arc::new(|_| {}));
        assert!(again.is_ready());
        let _ = fs::remove_dir_all(&r.root);
    }

    #[test]
    fn a_file_that_does_not_match_its_hash_is_refused_and_removed() {
        let r = rig("bad", Network::Unmetered, true);
        r.store.download();
        let s = wait_for(&r.store, |k| k == StateKind::Failed);
        assert_eq!(s.error.as_deref(), Some("b.bin did not match its checksum"));
        assert!(!r.store.directory().join("b.bin").exists());
        assert!(!r.store.directory().join("b.bin.part").exists());
        assert!(!r.store.is_complete());
        let _ = fs::remove_dir_all(&r.root);
    }

    #[test]
    fn a_dropped_download_resumes_from_the_partial_file() {
        let r = rig("resume", Network::Unmetered, false);
        *r.fake.cut_after.lock().unwrap() = Some(120_000);
        r.store.download();
        let s = wait_for(&r.store, |k| k == StateKind::Failed);
        assert_eq!(s.error.as_deref(), Some("Could not download a.bin"));
        let part = r.store.directory().join("a.bin.part");
        let kept = fs::metadata(&part).unwrap().len();
        assert_eq!(kept, 120_000);
        r.store.download();
        wait_for(&r.store, |k| k == StateKind::Ready);
        let ranges = r.fake.ranges.lock().unwrap().clone();
        assert_eq!(ranges[0], None);
        assert_eq!(ranges[1].as_deref(), Some("bytes=120000-"));
        assert_eq!(fs::read(r.store.directory().join("a.bin")).unwrap(), r.files[0].1);
        let _ = fs::remove_dir_all(&r.root);
    }

    #[test]
    fn a_server_that_ignores_the_range_still_gives_a_correct_file() {
        let r = rig("norange", Network::Unmetered, false);
        fs::create_dir_all(r.store.directory()).unwrap();
        fs::write(r.store.directory().join("a.bin.part"), &r.files[0].1[..1000]).unwrap();
        r.fake.ignore_range.store(true, Ordering::SeqCst);
        r.store.download();
        wait_for(&r.store, |k| k == StateKind::Ready);
        assert_eq!(fs::read(r.store.directory().join("a.bin")).unwrap(), r.files[0].1);
        let _ = fs::remove_dir_all(&r.root);
    }

    #[test]
    fn a_metered_connection_waits_and_downloads_when_it_is_not() {
        let r = rig("metered", Network::Metered, false);
        r.store.download_when_unmetered();
        std::thread::sleep(Duration::from_millis(80));
        assert!(r.store.status().waiting_for_network);
        assert_eq!(r.fake.hits.load(Ordering::SeqCst), 0, "nothing is fetched over a metered connection");
        *r.net.0.lock().unwrap() = Network::Unmetered;
        wait_for(&r.store, |k| k == StateKind::Ready);
        assert!(!r.store.status().waiting_for_network);
        let _ = fs::remove_dir_all(&r.root);
    }

    #[test]
    fn an_offline_wait_can_be_cancelled_and_deleted() {
        let r = rig("offline", Network::Offline, false);
        r.store.download_when_unmetered();
        assert!(r.store.status().waiting_for_network);
        r.store.cancel();
        assert!(!r.store.status().waiting_for_network);
        r.store.download();
        wait_for(&r.store, |k| k == StateKind::Ready);
        r.store.delete();
        assert_eq!(r.store.status().state, StateKind::Missing);
        assert!(!r.store.directory().exists());
        let _ = fs::remove_dir_all(&r.root);
    }

    #[test]
    fn files_already_in_place_are_not_fetched_again() {
        let r = rig("skip", Network::Unmetered, false);
        r.store.download();
        wait_for(&r.store, |k| k == StateKind::Ready);
        let hits = r.fake.hits.load(Ordering::SeqCst);
        fs::remove_file(r.store.directory().join("b.bin")).unwrap();
        let again = VoiceModelStore::new(r.store.model().clone(), r.root.clone(), r.net.clone(), Arc::new(|_| {}));
        assert!(!again.is_ready());
        again.download();
        wait_for(&again, |k| k == StateKind::Ready);
        assert_eq!(r.fake.hits.load(Ordering::SeqCst), hits + 1);
        let _ = fs::remove_dir_all(&r.root);
    }
}
