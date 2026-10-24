//! Resumable download of the signed desktop update bundle.
//!
//! `tauri-plugin-updater` fetches the bundle with one request into memory: a dropped
//! connection starts over from zero, and a connection that stops sending data hangs forever.
//! Pier downloads the bundle itself into `<app cache>/updates/` instead:
//!
//! - `pier-<version>.part` holds the bytes received so far and `pier-<version>.json` records
//!   which release they belong to (version and signature), the size, and the server's
//!   validator (strong `ETag` or `Last-Modified`).
//! - An interrupted download continues with `Range: bytes=<received>-` (with `If-Range` when
//!   the same address served the earlier bytes), after a dropped connection, a stall, a pause,
//!   or a restart of Pier. A server that ignores the range answers `200`, and the download
//!   starts over.
//! - Network failures are retried automatically with a growing delay; the counter resets
//!   whenever data arrives.
//! - The finished file is verified exactly as the plugin would (minisign signature against the
//!   built-in public key, and the signed version when the signature records one) before it is
//!   handed to `Update::install`. A resumed file that fails verification is downloaded once
//!   more from scratch, so a corrupted partial file cannot block an update.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE,
    LAST_MODIFIED, RANGE,
};
use reqwest::StatusCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::Url;

/// The release to download, as announced by the update manifest.
#[derive(Clone, Debug)]
pub struct Package {
    /// Download address (already routed through the selected mirror).
    pub url: Url,
    pub version: String,
    /// Base64 minisign signature from the manifest.
    pub signature: String,
    pub headers: HeaderMap,
}

#[derive(Clone, Debug)]
pub struct Policy {
    /// Until the response headers arrive (DNS, connection, TLS, redirects).
    pub request_timeout: Duration,
    /// No body data for this long counts as a dropped connection.
    pub stall_timeout: Duration,
    /// Consecutive failed attempts without new data before giving up.
    pub retries: u32,
    /// Delay before the first retry; doubled for each further one, up to `max_backoff`.
    pub backoff: Duration,
    pub max_backoff: Duration,
    /// Refuse bundles larger than this.
    pub max_bytes: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(30),
            retries: 5,
            backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(16),
            max_bytes: 1 << 30,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// The last attempt failed (`error`); attempt `attempt` of `of` starts after `delay`.
    Retrying {
        attempt: u32,
        of: u32,
        delay: Duration,
        error: String,
    },
}

/// Checks a downloaded bundle against the updater's public key.
#[derive(Clone, Debug)]
pub struct Verifier {
    pubkey: String,
    require_signed_version: bool,
}

impl Verifier {
    pub fn new(pubkey: impl Into<String>, require_signed_version: bool) -> Self {
        Self {
            pubkey: pubkey.into(),
            require_signed_version,
        }
    }

    /// From the `plugins.updater` section of `tauri.conf.json`.
    pub fn from_config(config: Option<&serde_json::Value>) -> Result<Self, String> {
        let config = config.ok_or("未配置更新公钥")?;
        let pubkey = config
            .get("pubkey")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .ok_or("未配置更新公钥")?;
        let require_signed_version = config
            .get("requireSignedVersion")
            .or_else(|| config.get("require-signed-version"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        Ok(Self::new(pubkey, require_signed_version))
    }

    /// Same checks as `tauri-plugin-updater`: the minisign signature over the data, then the
    /// version recorded in the (signed) trusted comment against the announced version.
    pub fn verify(&self, data: &[u8], signature: &str, version: &str) -> Result<(), String> {
        let public_key = PublicKey::decode(&base64_text(&self.pubkey)?)
            .map_err(|e| format!("更新公钥无效：{e}"))?;
        let signature = Signature::decode(&base64_text(signature)?)
            .map_err(|e| format!("更新签名无效：{e}"))?;
        public_key
            .verify(data, &signature, true)
            .map_err(|e| format!("签名不匹配：{e}"))?;
        // The trusted comment is covered by the signature, so it is usable only now.
        let Some(signed) = signature
            .trusted_comment()
            .split('\t')
            .find_map(|field| field.strip_prefix("version:"))
        else {
            return if self.require_signed_version {
                Err("签名中没有记录版本号".into())
            } else {
                Ok(())
            };
        };
        let matches = match (
            Version::from_str(signed.trim_start_matches('v')),
            Version::from_str(version.trim_start_matches('v')),
        ) {
            (Ok(signed), Ok(announced)) => signed == announced,
            _ => signed == version,
        };
        if matches {
            Ok(())
        } else {
            Err(format!(
                "签名对应的版本 {signed} 与发布的版本 {version} 不一致"
            ))
        }
    }
}

fn base64_text(value: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|e| format!("签名或公钥不是有效的 Base64：{e}"))?;
    String::from_utf8(bytes).map_err(|_| "签名或公钥不是有效的文本".into())
}

/// What `pier-<version>.json` records about the matching `.part` file.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    version: String,
    signature: String,
    #[serde(default)]
    total: Option<u64>,
    /// The request address that sent `validator`.
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    validator: Option<String>,
}

impl Meta {
    fn new(package: &Package) -> Self {
        Self {
            version: package.version.clone(),
            signature: package.signature.clone(),
            ..Self::default()
        }
    }

    fn matches(&self, version: &str, signature: &str) -> bool {
        self.version == version && self.signature == signature
    }
}

struct Paths {
    part: PathBuf,
    meta: PathBuf,
    /// `meta` is written here first, then renamed.
    meta_tmp: PathBuf,
}

impl Paths {
    fn contains(&self, path: &Path) -> bool {
        self.part == path || self.meta == path || self.meta_tmp == path
    }
}

/// The downloads kept in `<app cache>/updates/`.
#[derive(Clone, Debug)]
pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn paths(&self, version: &str) -> Paths {
        let stem: String = version
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        Paths {
            part: self.dir.join(format!("pier-{stem}.part")),
            meta: self.dir.join(format!("pier-{stem}.json")),
            meta_tmp: self.dir.join(format!("pier-{stem}.json.tmp")),
        }
    }

    fn read_meta(path: &Path) -> Option<Meta> {
        serde_json::from_slice(&fs::read(path).ok()?).ok()
    }

    /// Bytes already downloaded for this release, and its size when known.
    pub fn partial(&self, version: &str, signature: &str) -> Option<(u64, Option<u64>)> {
        let paths = self.paths(version);
        let meta = Self::read_meta(&paths.meta).filter(|meta| meta.matches(version, signature))?;
        let size = fs::metadata(&paths.part).ok()?.len();
        (size > 0 && meta.total.is_none_or(|total| size <= total)).then_some((size, meta.total))
    }

    /// Delete every cached download except those `keep` accepts (by version and signature).
    pub fn prune(&self, keep: impl Fn(&str, &str) -> bool) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let files: Vec<_> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .collect();
        let kept: Vec<Paths> = files
            .iter()
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .filter_map(|path| Self::read_meta(path))
            .filter(|meta| keep(&meta.version, &meta.signature))
            .map(|meta| self.paths(&meta.version))
            .collect();
        for path in files {
            if !kept.iter().any(|paths| paths.contains(&path)) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// How one request ended without a usable file.
enum Failure {
    /// Worth another attempt (network trouble, a busy server, changed content).
    Retry(String),
    Fatal(String),
}

/// How one request ended.
enum Fetched {
    /// The file is complete (or its size is unknown and the body ended normally).
    Complete,
    /// The server sent less than the rest of the file; ask for the remainder right away.
    Partial,
}

/// The state of one download, persisted across attempts.
struct Transfer<'a> {
    package: &'a Package,
    paths: Paths,
    meta: Meta,
    /// Bytes in the `.part` file.
    offset: u64,
    /// Part of the file was received by an earlier request (a resumed download).
    spliced: bool,
}

pub struct Downloader {
    cache: Cache,
    client: reqwest::Client,
    verifier: Verifier,
    policy: Policy,
}

/// Only one download writes to the cache at a time: a paused download may still be finishing
/// its last write when the next one starts.
static WRITER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl Downloader {
    pub fn new(cache: Cache, verifier: Verifier, policy: Policy) -> Result<Self, String> {
        // reqwest is built without a bundled TLS provider (as in tauri-plugin-updater).
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!("pier-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("无法创建下载连接：{e}"))?;
        Ok(Self {
            cache,
            client,
            verifier,
            policy,
        })
    }

    /// Download (or continue downloading) the release and return its verified contents.
    pub async fn download(
        &self,
        package: &Package,
        mut on_event: impl FnMut(Event),
    ) -> Result<Vec<u8>, String> {
        let _writer = WRITER.lock().await;
        fs::create_dir_all(&self.cache.dir)
            .map_err(|e| format!("下载更新失败：无法创建更新缓存目录：{e}"))?;
        let mut transfer = self.resume(package);
        let mut restarted = false;
        loop {
            self.fetch(&mut transfer, &mut on_event).await?;
            let bytes = fs::read(&transfer.paths.part)
                .map_err(|e| format!("下载更新失败：无法读取下载的更新包：{e}"))?;
            match self
                .verifier
                .verify(&bytes, &package.signature, &package.version)
            {
                Ok(()) => return Ok(bytes),
                Err(error) => {
                    let spliced = transfer.spliced;
                    self.reset(&mut transfer);
                    let _ = fs::remove_file(&transfer.paths.meta);
                    if spliced && !restarted {
                        // The earlier bytes may be damaged; try once more from scratch.
                        restarted = true;
                        on_event(Event::Progress {
                            downloaded: 0,
                            total: None,
                        });
                        continue;
                    }
                    return Err(format!("更新包校验失败：{error}"));
                }
            }
        }
    }

    /// Pick up the cached bytes of this release, or start fresh.
    fn resume<'a>(&self, package: &'a Package) -> Transfer<'a> {
        let paths = self.cache.paths(&package.version);
        let size = fs::metadata(&paths.part).map(|m| m.len()).unwrap_or(0);
        let meta = Cache::read_meta(&paths.meta).filter(|meta| {
            meta.matches(&package.version, &package.signature)
                && meta.total.is_none_or(|total| size <= total)
        });
        match meta {
            Some(meta) => Transfer {
                package,
                paths,
                meta,
                offset: size,
                spliced: size > 0,
            },
            None => {
                let _ = fs::remove_file(&paths.part);
                let _ = fs::remove_file(&paths.meta);
                Transfer {
                    package,
                    paths,
                    meta: Meta::new(package),
                    offset: 0,
                    spliced: false,
                }
            }
        }
    }

    /// Throw the received bytes away (the server sent something else).
    fn reset(&self, transfer: &mut Transfer<'_>) {
        let _ = fs::remove_file(&transfer.paths.part);
        transfer.offset = 0;
        transfer.spliced = false;
        transfer.meta = Meta::new(transfer.package);
    }

    fn save_meta(&self, transfer: &Transfer<'_>) -> Result<(), Failure> {
        let text = serde_json::to_vec_pretty(&transfer.meta)
            .map_err(|e| Failure::Fatal(format!("无法保存下载进度：{e}")))?;
        let paths = &transfer.paths;
        fs::write(&paths.meta_tmp, text)
            .and_then(|()| fs::rename(&paths.meta_tmp, &paths.meta))
            .map_err(|e| Failure::Fatal(format!("无法保存下载进度：{e}")))
    }

    /// Request the missing bytes until the file is complete, retrying network failures.
    async fn fetch(
        &self,
        transfer: &mut Transfer<'_>,
        on_event: &mut impl FnMut(Event),
    ) -> Result<(), String> {
        let mut failures = 0;
        on_event(Event::Progress {
            downloaded: transfer.offset,
            total: transfer.meta.total,
        });
        loop {
            if transfer.meta.total == Some(transfer.offset) && transfer.offset > 0 {
                return Ok(());
            }
            let before = transfer.offset;
            let error = match self.attempt(transfer, on_event).await {
                Ok(Fetched::Complete) => return Ok(()),
                Ok(Fetched::Partial) if transfer.offset > before => {
                    failures = 0;
                    continue;
                }
                Ok(Fetched::Partial) => "服务器没有发送新的数据".to_string(),
                Err(Failure::Fatal(error)) => return Err(format!("下载更新失败：{error}")),
                Err(Failure::Retry(error)) => error,
            };
            if transfer.offset > before {
                failures = 0;
            }
            failures += 1;
            if failures > self.policy.retries {
                return Err(format!(
                    "下载更新失败：{error}（已自动重试 {} 次）",
                    self.policy.retries
                ));
            }
            let delay = self
                .policy
                .backoff
                .saturating_mul(1 << (failures - 1).min(16))
                .min(self.policy.max_backoff);
            on_event(Event::Retrying {
                attempt: failures,
                of: self.policy.retries,
                delay,
                error,
            });
            tokio::time::sleep(delay).await;
        }
    }

    async fn attempt(
        &self,
        transfer: &mut Transfer<'_>,
        on_event: &mut impl FnMut(Event),
    ) -> Result<Fetched, Failure> {
        let package = transfer.package;
        let mut headers = package.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        }
        // Ranges count bytes of the stored file, so no transfer compression.
        headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
        let resuming = transfer.offset > 0;
        if resuming {
            if let Ok(range) = HeaderValue::from_str(&format!("bytes={}-", transfer.offset)) {
                headers.insert(RANGE, range);
            }
            let same_source = transfer.meta.source.as_deref() == Some(package.url.as_str());
            if let Some(validator) = transfer.meta.validator.as_deref().filter(|_| same_source) {
                if let Ok(value) = HeaderValue::from_str(validator) {
                    headers.insert(IF_RANGE, value);
                }
            }
        }
        let request = self.client.get(package.url.clone()).headers(headers);
        let mut response = tokio::time::timeout(self.policy.request_timeout, request.send())
            .await
            .map_err(|_| Failure::Retry("连接超时".into()))?
            .map_err(|e| Failure::Retry(network_error(&e)))?;

        let status = response.status();
        let append = match status {
            StatusCode::PARTIAL_CONTENT => {
                let Some((start, total)) = content_range(response.headers()) else {
                    self.reset(transfer);
                    return Err(Failure::Retry("服务器返回的续传范围无效".into()));
                };
                let size_changed =
                    matches!((transfer.meta.total, total), (Some(a), Some(b)) if a != b);
                if start != transfer.offset || size_changed {
                    self.reset(transfer);
                    return Err(Failure::Retry("服务器上的更新包已变化，重新下载".into()));
                }
                transfer.meta.total = total.or(transfer.meta.total);
                true
            }
            StatusCode::RANGE_NOT_SATISFIABLE if resuming => {
                let total = unsatisfied_range_total(response.headers());
                if total.is_some() && total == Some(transfer.offset) {
                    // Everything had already arrived.
                    transfer.meta.total = total;
                    self.save_meta(transfer)?;
                    return Ok(Fetched::Complete);
                }
                self.reset(transfer);
                return Err(Failure::Retry("服务器不接受续传，重新下载".into()));
            }
            status if status.is_success() => {
                // A full response: the server ignored the range or the file changed.
                transfer.offset = 0;
                transfer.spliced = false;
                transfer.meta.total = response
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse().ok());
                false
            }
            status if retryable(status) => {
                return Err(Failure::Retry(format!(
                    "服务器返回 HTTP {}",
                    status.as_u16()
                )));
            }
            status => {
                return Err(Failure::Fatal(format!(
                    "服务器返回 HTTP {}",
                    status.as_u16()
                )));
            }
        };
        if transfer
            .meta
            .total
            .is_some_and(|total| total > self.policy.max_bytes)
        {
            return Err(Failure::Fatal("更新包大小异常".into()));
        }
        if append {
            transfer.spliced = true;
        }
        transfer.meta.source = Some(package.url.to_string());
        transfer.meta.validator = validator(response.headers());
        self.save_meta(transfer)?;

        let file = if append {
            OpenOptions::new().append(true).open(&transfer.paths.part)
        } else {
            File::create(&transfer.paths.part)
        }
        .map_err(|e| Failure::Fatal(format!("无法写入更新缓存：{e}")))?;
        if append && file.metadata().map(|m| m.len()).ok() != Some(transfer.offset) {
            drop(file);
            self.reset(transfer);
            return Err(Failure::Retry("更新缓存已变化，重新下载".into()));
        }
        let mut file = BufWriter::with_capacity(256 * 1024, file);
        on_event(Event::Progress {
            downloaded: transfer.offset,
            total: transfer.meta.total,
        });

        loop {
            let chunk =
                match tokio::time::timeout(self.policy.stall_timeout, response.chunk()).await {
                    Err(_) => {
                        flush(&mut file)?;
                        return Err(Failure::Retry("连接没有响应".into()));
                    }
                    Ok(Err(error)) => {
                        flush(&mut file)?;
                        return Err(Failure::Retry(network_error(&error)));
                    }
                    Ok(Ok(None)) => break,
                    Ok(Ok(Some(chunk))) => chunk,
                };
            let next = transfer.offset + chunk.len() as u64;
            if next > self.policy.max_bytes {
                drop(file);
                self.reset(transfer);
                return Err(Failure::Fatal("更新包大小异常".into()));
            }
            if transfer.meta.total.is_some_and(|total| next > total) {
                drop(file);
                self.reset(transfer);
                return Err(Failure::Retry("收到的数据超过更新包大小，重新下载".into()));
            }
            file.write_all(&chunk)
                .map_err(|e| Failure::Fatal(format!("无法写入更新缓存：{e}")))?;
            transfer.offset = next;
            on_event(Event::Progress {
                downloaded: next,
                total: transfer.meta.total,
            });
        }
        flush(&mut file)?;
        drop(file);

        match transfer.meta.total {
            Some(total) if transfer.offset < total => Ok(Fetched::Partial),
            Some(_) => Ok(Fetched::Complete),
            None => {
                // No size was announced and the body ended normally.
                transfer.meta.total = Some(transfer.offset);
                self.save_meta(transfer)?;
                Ok(Fetched::Complete)
            }
        }
    }
}

fn flush(file: &mut BufWriter<File>) -> Result<(), Failure> {
    file.flush()
        .map_err(|e| Failure::Fatal(format!("无法写入更新缓存：{e}")))
}

fn retryable(status: StatusCode) -> bool {
    status.is_server_error()
        || status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
}

fn network_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "连接超时".into()
    } else if error.is_connect() {
        "无法连接到下载服务器".into()
    } else {
        "网络连接中断".into()
    }
}

/// `Content-Range: bytes <start>-<end>/<total or *>` of a `206` response.
fn content_range(headers: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    let (range, total) = value.trim().strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    if end < start {
        return None;
    }
    let total = match total.trim() {
        "*" => None,
        total => {
            let total: u64 = total.parse().ok()?;
            if end >= total {
                return None;
            }
            Some(total)
        }
    };
    Some((start, total))
}

/// `Content-Range: bytes */<total>` of a `416` response.
fn unsatisfied_range_total(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(CONTENT_RANGE)?.to_str().ok()?;
    value.trim().strip_prefix("bytes */")?.trim().parse().ok()
}

/// A validator usable in `If-Range`: a strong ETag, or else `Last-Modified`.
fn validator(headers: &HeaderMap) -> Option<String> {
    let text = |name: reqwest::header::HeaderName| {
        headers
            .get(name)
            .and_then(|value: &HeaderValue| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    text(ETAG)
        .filter(|etag| !etag.starts_with("W/"))
        .or_else(|| text(LAST_MODIFIED))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{BufRead, BufReader};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// `tauri signer generate` test key (not Pier's) and `tauri signer sign --app-version 9.8.7`
    /// over `package_bytes()`.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQxRjU4MERDMDRBQzBEMjAKUldRZ0Rhd0UzSUQxMFlZeFlyU1NENkliMGtxZmJtK1JCWjNEYWFpSEtMY0ljdXovVG5WVWpqdDkK";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRZ0Rhd0UzSUQxMFY2QVBpMHhrMi82OStsMTlHaDk3YnRSL0piMEw2aUw2endEZU1IcWNNMEVzWWcrWTJQSUJwbE5YZWZIZG11SmNJTFhCVDdZMDRsYytETGdwcmRtOWdJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODA5NTQ1CWZpbGU6cGtnLmJpbgl2ZXJzaW9uOjkuOC43CkJ1bmpnaXdXMHAzd0FGUC9HSWk2RHR6d0hoLzBOQTFvak1YUloxYXk4UTRTNDIzcm52d0hxRjFxelZQc0thc1QyWjJsZ3FqTnNzclBmcWd5eFo0NERBPT0K";
    const TEST_VERSION: &str = "9.8.7";

    fn package_bytes() -> Vec<u8> {
        (0..200_000u64)
            .map(|i| ((i * 7919 + i / 251) % 251) as u8)
            .collect()
    }

    /// How the test server answers one request.
    #[derive(Clone)]
    enum Reply {
        /// Honour `Range`, optionally sending only `cut` body bytes before closing, or
        /// stalling after them.
        Serve {
            cut: Option<usize>,
            stall: bool,
            ignore_range: bool,
        },
        Status(u16),
        /// Serve this body instead (honouring `Range`).
        Body(Vec<u8>),
    }

    const SERVE: Reply = Reply::Serve {
        cut: None,
        stall: false,
        ignore_range: false,
    };

    /// The `Range` and `If-Range` headers of one request.
    type Request = (Option<String>, Option<String>);

    struct Server {
        url: Url,
        /// Every request, in order.
        requests: Arc<Mutex<Vec<Request>>>,
    }

    impl Server {
        fn start(replies: Vec<Reply>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!(
                "http://{}/pier.bin",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
            let seen = requests.clone();
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let reply = replies.lock().unwrap().pop_front().unwrap_or(SERVE);
                    let seen = seen.clone();
                    thread::spawn(move || handle(stream, reply, &seen));
                }
            });
            Self { url, requests }
        }

        fn requests(&self) -> Vec<Request> {
            self.requests.lock().unwrap().clone()
        }
    }

    fn handle(mut stream: TcpStream, reply: Reply, seen: &Mutex<Vec<Request>>) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let (mut range, mut if_range) = (None, None);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                let value = Some(value.trim().to_string());
                match name.to_ascii_lowercase().as_str() {
                    "range" => range = value,
                    "if-range" => if_range = value,
                    _ => {}
                }
            }
        }
        seen.lock().unwrap().push((range.clone(), if_range));
        let (body, cut, stall, ignore_range) = match reply {
            Reply::Status(code) => {
                let _ = write!(
                    stream,
                    "HTTP/1.1 {code} Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                return;
            }
            Reply::Body(body) => (body, None, false, false),
            Reply::Serve {
                cut,
                stall,
                ignore_range,
            } => (package_bytes(), cut, stall, ignore_range),
        };
        let total = body.len();
        let start = range.filter(|_| !ignore_range).and_then(|range| {
            range
                .strip_prefix("bytes=")?
                .strip_suffix('-')?
                .parse()
                .ok()
        });
        let head = match start {
            Some(start) if start >= total => {
                let _ = write!(
                    stream,
                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                return;
            }
            Some(start) => format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{}/{total}\r\nContent-Length: {}\r\n",
                total - 1,
                total - start
            ),
            None => format!("HTTP/1.1 200 OK\r\nContent-Length: {total}\r\n"),
        };
        let start = start.unwrap_or(0);
        let _ = write!(
            stream,
            "{head}ETag: \"pier-test\"\r\nConnection: close\r\n\r\n"
        );
        let end = cut.map_or(total, |cut| (start + cut).min(total));
        let _ = stream.write_all(&body[start..end]);
        let _ = stream.flush();
        if stall {
            thread::sleep(Duration::from_millis(1500));
        }
    }

    fn policy() -> Policy {
        Policy {
            request_timeout: Duration::from_secs(5),
            stall_timeout: Duration::from_millis(300),
            retries: 3,
            backoff: Duration::from_millis(10),
            max_backoff: Duration::from_millis(20),
            max_bytes: 1 << 20,
        }
    }

    fn downloader(dir: &Path) -> Downloader {
        Downloader::new(
            Cache::new(dir.to_path_buf()),
            Verifier::new(TEST_PUBKEY, false),
            policy(),
        )
        .unwrap()
    }

    fn package(url: &Url) -> Package {
        Package {
            url: url.clone(),
            version: TEST_VERSION.into(),
            signature: TEST_SIGNATURE.into(),
            headers: HeaderMap::new(),
        }
    }

    fn run(downloader: &Downloader, package: &Package) -> (Result<Vec<u8>, String>, Vec<Event>) {
        let mut events = Vec::new();
        let result = tauri::async_runtime::block_on(
            downloader.download(package, |event| events.push(event)),
        );
        (result, events)
    }

    fn retries(events: &[Event]) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, Event::Retrying { .. }))
            .count()
    }

    #[test]
    fn verifies_signature_and_signed_version_like_the_plugin() {
        let data = package_bytes();
        let verifier = Verifier::new(TEST_PUBKEY, true);
        verifier.verify(&data, TEST_SIGNATURE, "9.8.7").unwrap();
        verifier.verify(&data, TEST_SIGNATURE, "v9.8.7").unwrap();
        assert!(verifier
            .verify(&data, TEST_SIGNATURE, "9.8.8")
            .unwrap_err()
            .contains("9.8.8"));
        let mut tampered = data.clone();
        tampered[1234] ^= 1;
        assert!(verifier.verify(&tampered, TEST_SIGNATURE, "9.8.7").is_err());
        assert!(Verifier::new("bm90IGEga2V5", false)
            .verify(&data, TEST_SIGNATURE, "9.8.7")
            .is_err());
    }

    #[test]
    fn reads_the_updater_config() {
        let config = serde_json::json!({ "pubkey": TEST_PUBKEY, "requireSignedVersion": true });
        let verifier = Verifier::from_config(Some(&config)).unwrap();
        assert!(verifier.require_signed_version);
        assert!(Verifier::from_config(Some(&serde_json::json!({}))).is_err());
        assert!(Verifier::from_config(None).is_err());
    }

    #[test]
    fn resumes_after_the_connection_drops() {
        let server = Server::start(vec![Reply::Serve {
            cut: Some(70_000),
            stall: false,
            ignore_range: false,
        }]);
        let dir = tempfile::tempdir().unwrap();
        let (result, events) = run(&downloader(dir.path()), &package(&server.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(retries(&events), 1);
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], (None, None));
        assert_eq!(
            requests[1],
            (Some("bytes=70000-".into()), Some("\"pier-test\"".into()))
        );
        assert!(events.contains(&Event::Progress {
            downloaded: 200_000,
            total: Some(200_000)
        }));
    }

    #[test]
    fn retries_a_stalled_connection_from_where_it_stopped() {
        let server = Server::start(vec![Reply::Serve {
            cut: Some(50_000),
            stall: true,
            ignore_range: false,
        }]);
        let dir = tempfile::tempdir().unwrap();
        let (result, events) = run(&downloader(dir.path()), &package(&server.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(retries(&events), 1);
        assert_eq!(server.requests()[1].0.as_deref(), Some("bytes=50000-"));
    }

    #[test]
    fn continues_a_download_left_by_an_earlier_run() {
        let dir = tempfile::tempdir().unwrap();
        let first = Server::start(vec![
            Reply::Serve {
                cut: Some(120_000),
                stall: false,
                ignore_range: false,
            },
            Reply::Status(503),
            Reply::Status(503),
            Reply::Status(503),
        ]);
        let (result, events) = run(&downloader(dir.path()), &package(&first.url));
        assert!(result.unwrap_err().contains("HTTP 503"));
        assert_eq!(retries(&events), 3);
        let downloader = downloader(dir.path());
        assert_eq!(
            downloader.cache.partial(TEST_VERSION, TEST_SIGNATURE),
            Some((120_000, Some(200_000)))
        );
        assert_eq!(downloader.cache.partial(TEST_VERSION, "other"), None);

        // A restarted Pier, possibly on another route: no `If-Range` for a different address.
        let second = Server::start(vec![]);
        let (result, events) = run(&downloader, &package(&second.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(
            events.first(),
            Some(&Event::Progress {
                downloaded: 120_000,
                total: Some(200_000)
            })
        );
        assert_eq!(
            second.requests(),
            vec![(Some("bytes=120000-".into()), None)]
        );
    }

    #[test]
    fn continues_after_a_paused_download_is_aborted() {
        let dir = tempfile::tempdir().unwrap();
        let stalled = Server::start(vec![Reply::Serve {
            cut: Some(80_000),
            stall: true,
            ignore_range: false,
        }]);
        let (tx, rx) = std::sync::mpsc::channel();
        let first = downloader(dir.path());
        let paused = package(&stalled.url);
        let task = tauri::async_runtime::spawn(async move {
            first
                .download(&paused, |event| {
                    if let Event::Progress { downloaded, .. } = event {
                        let _ = tx.send(downloaded);
                    }
                })
                .await
        });
        while rx.recv_timeout(Duration::from_secs(5)).unwrap() < 80_000 {}
        task.abort();
        assert!(tauri::async_runtime::block_on(task).is_err());

        let server = Server::start(vec![]);
        let (result, _) = run(&downloader(dir.path()), &package(&server.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(server.requests(), vec![(Some("bytes=80000-".into()), None)]);
    }

    #[test]
    fn starts_over_when_the_server_ignores_the_range() {
        let server = Server::start(vec![
            Reply::Serve {
                cut: Some(60_000),
                stall: false,
                ignore_range: false,
            },
            Reply::Serve {
                cut: None,
                stall: false,
                ignore_range: true,
            },
        ]);
        let dir = tempfile::tempdir().unwrap();
        let (result, _) = run(&downloader(dir.path()), &package(&server.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn reuses_a_complete_verified_download_without_the_network() {
        let dir = tempfile::tempdir().unwrap();
        let server = Server::start(vec![]);
        let downloader = downloader(dir.path());
        assert_eq!(
            run(&downloader, &package(&server.url)).0.unwrap(),
            package_bytes()
        );
        // The address no longer answers; the cached file is enough.
        let offline = package(&Url::parse("http://127.0.0.1:9/pier.bin").unwrap());
        assert_eq!(run(&downloader, &offline).0.unwrap(), package_bytes());
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn redownloads_once_when_a_resumed_file_fails_verification() {
        let dir = tempfile::tempdir().unwrap();
        let downloader = downloader(dir.path());
        // A damaged partial file from an earlier run.
        let paths = downloader.cache.paths(TEST_VERSION);
        let mut damaged = package_bytes()[..90_000].to_vec();
        damaged[10] ^= 0xff;
        fs::write(&paths.part, damaged).unwrap();
        let mut meta = Meta::new(&package(&Url::parse("http://127.0.0.1:9/").unwrap()));
        meta.total = Some(200_000);
        fs::write(&paths.meta, serde_json::to_vec(&meta).unwrap()).unwrap();

        let server = Server::start(vec![]);
        let (result, _) = run(&downloader, &package(&server.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(
            server.requests(),
            vec![(Some("bytes=90000-".into()), None), (None, None)]
        );
    }

    #[test]
    fn rejects_a_tampered_bundle_and_drops_it() {
        let mut tampered = package_bytes();
        tampered[5] ^= 1;
        let server = Server::start(vec![Reply::Body(tampered)]);
        let dir = tempfile::tempdir().unwrap();
        let downloader = downloader(dir.path());
        let (result, _) = run(&downloader, &package(&server.url));
        assert!(result.unwrap_err().contains("校验失败"));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn gives_up_immediately_on_client_errors() {
        let server = Server::start(vec![Reply::Status(404)]);
        let dir = tempfile::tempdir().unwrap();
        let (result, events) = run(&downloader(dir.path()), &package(&server.url));
        assert!(result.unwrap_err().contains("HTTP 404"));
        assert_eq!(retries(&events), 0);
    }

    #[test]
    fn treats_a_complete_file_without_metadata_size_as_done() {
        let dir = tempfile::tempdir().unwrap();
        let downloader = downloader(dir.path());
        let paths = downloader.cache.paths(TEST_VERSION);
        fs::write(&paths.part, package_bytes()).unwrap();
        let meta = Meta::new(&package(&Url::parse("http://127.0.0.1:9/").unwrap()));
        fs::write(&paths.meta, serde_json::to_vec(&meta).unwrap()).unwrap();
        let server = Server::start(vec![]);
        let (result, _) = run(&downloader, &package(&server.url));
        assert_eq!(result.unwrap(), package_bytes());
        assert_eq!(
            server.requests(),
            vec![(Some("bytes=200000-".into()), None)]
        );
    }

    #[test]
    fn prunes_downloads_of_other_releases() {
        let dir = tempfile::tempdir().unwrap();
        let downloader = downloader(dir.path());
        for (version, signature) in [("1.0.0", "a"), ("2.0.0", "b"), ("3.0.0", "c")] {
            let paths = downloader.cache.paths(version);
            fs::write(&paths.part, b"x").unwrap();
            let meta = Meta {
                version: version.into(),
                signature: signature.into(),
                ..Meta::default()
            };
            fs::write(&paths.meta, serde_json::to_vec(&meta).unwrap()).unwrap();
        }
        fs::write(dir.path().join("leftover.json.tmp"), b"").unwrap();
        downloader
            .cache
            .prune(|version, signature| version == "2.0.0" && signature == "b");
        let mut names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["pier-2.0.0.json", "pier-2.0.0.part"]);
        assert_eq!(downloader.cache.partial("2.0.0", "b"), Some((1, None)));
    }

    #[test]
    fn parses_content_ranges() {
        let headers = |value: &str| {
            let mut map = HeaderMap::new();
            map.insert(CONTENT_RANGE, HeaderValue::from_str(value).unwrap());
            map
        };
        assert_eq!(
            content_range(&headers("bytes 10-99/100")),
            Some((10, Some(100)))
        );
        assert_eq!(content_range(&headers("bytes 10-99/*")), Some((10, None)));
        assert_eq!(content_range(&headers("bytes 10-100/100")), None);
        assert_eq!(content_range(&headers("bytes 20-10/100")), None);
        assert_eq!(content_range(&headers("items 0-1/2")), None);
        assert_eq!(unsatisfied_range_total(&headers("bytes */100")), Some(100));

        let mut map = HeaderMap::new();
        map.insert(ETAG, HeaderValue::from_static("W/\"weak\""));
        map.insert(
            LAST_MODIFIED,
            HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"),
        );
        assert_eq!(
            validator(&map).as_deref(),
            Some("Wed, 21 Oct 2026 07:28:00 GMT")
        );
        map.insert(ETAG, HeaderValue::from_static("\"strong\""));
        assert_eq!(validator(&map).as_deref(), Some("\"strong\""));
    }
}
