//! 备份与恢复：本地 zip 包 + WebDAV 远端。
//!
//! 备份包就是一个普通 zip，放在哪里都能用解压软件打开看：
//!
//! ```text
//! manifest.json   格式标识 / 版本 / 时间 / 书数，恢复前先校验
//! cenro.db        SQLite 快照
//! covers/*.jpg    封面缩略图（可选；不含时恢复后跑一次「重建封面」）
//! ```
//!
//! 数据库快照用 SQLite 自己的 backup API 生成，而不是直接复制文件：
//! 库开着 WAL，最新的阅读进度可能还躺在 `-wal` 里，裸拷 `cenro.db`
//! 拿到的是旧快照，运气不好还会拷到写了一半的页。
//!
//! 恢复同样走 backup API 写回**当前打开的连接**，不换文件、不重启应用。
//! 换文件的话得先把连接关掉——Mutex 里拿着 `Connection`，Windows 上
//! 还没法删占用的文件，绕起来比这一步麻烦得多。

use crate::db;
use crate::error::{AppError, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MANIFEST_ENTRY: &str = "manifest.json";
const DB_ENTRY: &str = "cenro.db";
const COVER_PREFIX: &str = "covers/";
const BACKUP_APP: &str = "cenro";
/// 备份包内部格式版本。将来结构变了就加一，旧包仍能按旧规则读。
const BACKUP_FORMAT: u32 = 1;

/// 备份包里的说明文件。
#[derive(Serialize, Deserialize, Clone)]
pub struct Manifest {
    pub app: String,
    pub format: u32,
    pub version: String,
    pub created_at: i64,
    pub books: i64,
    pub covers: usize,
    /// 包里**包含**的隐私书数量。老包没有这个字段，按 0 读。
    #[serde(default)]
    pub private_books: i64,
    pub platform: String,
}

#[derive(Serialize, Debug)]
pub struct ExportReport {
    /// 本地文件路径，或 WebDAV 上的完整地址
    pub path: String,
    pub bytes: u64,
    pub books: i64,
    pub covers: usize,
    /// 包里带了几本隐私书（0 表示没有，或用户选择不备份）
    pub private_books: i64,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
pub struct RestoreReport {
    pub from: String,
    pub books: i64,
    pub covers: usize,
    /// 恢复回来的书里有几本属于隐私书架——这些不会出现在普通书架上
    pub private_books: i64,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
pub struct LocalBackup {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
pub struct RemoteBackup {
    pub name: String,
    pub bytes: u64,
    /// 服务器返回的 Last-Modified 原文，前端不解析、只展示
    pub modified: String,
}

// ---------------- 时间与命名 ----------------

/// 临时文件路径。必须带递增序号：同一进程里并行跑多个导出（测试、或将来批量备份）
/// 时只按 pid 命名会互相踩，一个把另一个正在写的快照删掉，
/// 报出来的还是「attempt to write a readonly database」，极难定位。
fn temp_path(prefix: &str, ext: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{}-{seq}.{ext}", std::process::id()))
}

fn now_ts() -> i64 {
    db::now_ts()
}

/// 文件名里用的时间戳：`20261115-192312`（本地时区，精确到秒）。
/// 用本地时间是为了让用户在文件夹和 WebDAV 客户端里一眼对上「我刚备份的」。
pub fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

pub fn backup_file_name() -> String {
    format!("cenro-backup-{}.zip", stamp())
}

// ---------------- 备份范围 ----------------

/// 备份前的「范围」：总共多少本、其中多少本在隐私书架。
///
/// 前端拿它决定要不要弹「是否一并备份隐私书」。单独一条命令而不是塞进
/// `library_stats`，是因为统计口径将来要按隐私书架分开（P1），而这里问的是
/// 「这次备份会包含什么」，语义不同。
#[derive(Serialize, Debug)]
pub struct BackupScope {
    pub books: i64,
    pub private_books: i64,
}

pub fn scope(conn: &Connection) -> Result<BackupScope> {
    Ok(BackupScope {
        books: db::count_books(conn)?,
        private_books: db::count_private(conn)?,
    })
}

// ---------------- 导出 ----------------

/// 生成备份包。
///
/// - `include_covers = false`：只带数据库，包小很多
/// - `include_private = false`：把隐私书架整批剔掉（默认，见 `backup_scope`）
///
/// 隐私书的排除是在**快照副本上**做的：`Connection::backup` 只能整库复制，
/// 没有「按行导出」这回事。所以先把库拍进临时文件，再在那个独占副本里
/// `DELETE FROM books WHERE private = 1`，然后是压缩。原始库一个字节都不动。
pub fn export(
    conn: &Connection,
    cover_dir: &Path,
    target: &Path,
    include_covers: bool,
    include_private: bool,
    app_version: &str,
) -> Result<ExportReport> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let created_at = now_ts();

    // 1. 数据库快照落到临时文件
    let tmp_db = temp_path("cenro-snapshot", "db");
    let _ = std::fs::remove_file(&tmp_db);
    conn.backup("main", &tmp_db, None::<fn(rusqlite::backup::Progress)>)?;

    // 2. 按需剔除隐私书（只动副本）
    let result = (|| -> Result<(i64, i64, Vec<PathBuf>)> {
        let snapshot = Connection::open(&tmp_db)?;
        if !include_private {
            /*
             * 先删标注再删书：快照是**新开的连接**，`foreign_keys` 默认关闭，
             * ON DELETE CASCADE 不会生效。只删 books 会把私密书的书签、备注留在包里——
             * 备注往往是用户自己打的原文，泄露的严重程度不比书本身低。
             */
            snapshot.execute(
                "DELETE FROM annotations WHERE book_id IN (SELECT id FROM books WHERE private = 1)",
                [],
            )?;
            snapshot.execute("DELETE FROM books WHERE private = 1", [])?;
        }

        let books = snapshot.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?;
        let private_books =
            snapshot.query_row("SELECT COUNT(*) FROM books WHERE private = 1", [], |r| r.get(0))?;

        // 3. 封面按包里实际留下的 id 取：孤儿的 jpg（记录已删）不该跟着走
        let mut ids = std::collections::HashSet::new();
        {
            let mut stmt = snapshot.prepare("SELECT id FROM books")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for row in rows {
                ids.insert(row?);
            }
        }
        let covers = if include_covers {
            collect_covers(cover_dir, &ids)
        } else {
            Vec::new()
        };
        Ok((books, private_books, covers))
    })();

    let (books, private_books, covers) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_db);
            return Err(e);
        }
    };

    let manifest = Manifest {
        app: BACKUP_APP.into(),
        format: BACKUP_FORMAT,
        version: app_version.to_string(),
        created_at,
        books,
        covers: covers.len(),
        private_books,
        platform: std::env::consts::OS.to_string(),
    };

    let written = write_zip(target, &tmp_db, &covers, &manifest);
    let _ = std::fs::remove_file(&tmp_db);
    written?;

    let bytes = std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);
    Ok(ExportReport {
        path: target.to_string_lossy().into_owned(),
        bytes,
        books,
        covers: covers.len(),
        private_books,
        created_at,
    })
}

/// 收集封面：只取 `{book_id}.jpg` 且 id 仍在包内的那些。
fn collect_covers(
    cover_dir: &Path,
    ids: &std::collections::HashSet<String>,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(cover_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            if !p.is_file() {
                return false;
            }
            let is_jpg = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
                .unwrap_or(false);
            if !is_jpg {
                return false;
            }
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(|stem| ids.contains(stem))
                .unwrap_or(false)
        })
        .collect()
}

fn write_zip(target: &Path, tmp_db: &Path, covers: &[PathBuf], manifest: &Manifest) -> Result<()> {
    let file = std::fs::File::create(target)?;
    let mut zip = zip::ZipWriter::new(file);

    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    // 封面已经是 jpg，再压一遍只是白烧 CPU
    let stored = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    let manifest_json = serde_json::to_vec_pretty(manifest)?;
    zip.start_file(MANIFEST_ENTRY, deflated)?;
    zip.write_all(&manifest_json)?;

    zip.start_file(DB_ENTRY, deflated)?;
    let mut db_file = std::fs::File::open(tmp_db)?;
    let mut buf = Vec::with_capacity(1 << 20);
    db_file.read_to_end(&mut buf)?;
    zip.write_all(&buf)?;

    for cover in covers {
        let Some(name) = cover.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        zip.start_file(format!("{COVER_PREFIX}{name}"), stored)?;
        let mut f = std::fs::File::open(cover)?;
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes)?;
        zip.write_all(&bytes)?;
    }

    zip.finish()?;
    Ok(())
}

// ---------------- 恢复 ----------------

/// 用备份包覆盖当前书库。只动数据库与封面缩略图，磁盘上的书籍文件不碰。
pub fn restore(conn: &mut Connection, cover_dir: &Path, archive: &Path) -> Result<RestoreReport> {
    if !archive.exists() {
        return Err(AppError::Other("备份文件不存在".into()));
    }

    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;

    let manifest: Manifest = {
        let mut entry = zip
            .by_name(MANIFEST_ENTRY)
            .map_err(|_| AppError::Other("这不是岑序的备份包：缺少 manifest.json".into()))?;
        let mut text = String::new();
        entry.read_to_string(&mut text)?;
        serde_json::from_str(&text)
            .map_err(|_| AppError::Other("备份包的 manifest.json 已损坏".into()))?
    };

    if manifest.app != BACKUP_APP {
        return Err(AppError::Other(
            "这不是岑序的备份包（manifest.json 里的应用名不匹配）".into(),
        ));
    }
    if manifest.format > BACKUP_FORMAT {
        return Err(AppError::Other(format!(
            "备份包格式版本 {} 比当前应用新，请先升级应用",
            manifest.format
        )));
    }

    // 1. 库文件解到临时目录
    let tmp_db = temp_path("cenro-restore", "db");
    let _ = std::fs::remove_file(&tmp_db);
    {
        let mut entry = zip
            .by_name(DB_ENTRY)
            .map_err(|_| AppError::Other("备份包里没有数据库文件".into()))?;
        let mut out = std::fs::File::create(&tmp_db)?;
        std::io::copy(&mut entry, &mut out)?;
    }

    // 2. 逐个快照写回当前连接
    conn.restore("main", &tmp_db, None::<fn(rusqlite::backup::Progress)>)?;
    let _ = std::fs::remove_file(&tmp_db);

    // 3. 老备份可能来自更早的版本，补列 / 放开 CHECK 一并跑一遍
    db::init(conn)?;

    // 4. 封面：先清空再解，避免旧封面和新记录张冠李戴
    let covers = extract_covers(&mut zip, cover_dir)?;
    remap_covers(conn, cover_dir)?;

    Ok(RestoreReport {
        from: archive.to_string_lossy().into_owned(),
        books: db::count_books(conn)?,
        covers,
        private_books: db::count_private(conn)?,
        created_at: manifest.created_at,
    })
}

fn extract_covers(zip: &mut zip::ZipArchive<std::fs::File>, cover_dir: &Path) -> Result<usize> {
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| {
            let f = zip.by_index(i).ok()?;
            f.name().ok().map(|n| n.to_string())
        })
        .filter(|n| n.starts_with(COVER_PREFIX) && !n.ends_with('/'))
        .collect();

    if names.is_empty() {
        // 不含封面的包：把旧的清掉，让封面状态退回 pending，交给「重建封面」
        let _ = crate::cache::clear_dir(cover_dir);
        return Ok(0);
    }

    let _ = crate::cache::clear_dir(cover_dir);
    std::fs::create_dir_all(cover_dir)?;

    let mut written = 0;
    for name in names {
        let Some(file_name) = name.rsplit('/').next().filter(|n| !n.is_empty()) else {
            continue;
        };
        let mut entry = match zip.by_name(&name) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        std::fs::write(cover_dir.join(file_name), &bytes)?;
        written += 1;
    }
    Ok(written)
}

/// 把 `cover_path` 重指到本机封面目录。
///
/// 备份里存的是**备份那台机器**的绝对路径，换设备或换用户名之后全是死链，
/// 书架会整片裂图。判据只有一条：本机封面目录里有没有 `<book_id>.jpg`。
fn remap_covers(conn: &Connection, cover_dir: &Path) -> Result<()> {
    let mut stmt = conn.prepare("SELECT id FROM books")?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for id in ids {
        let file = cover_dir.join(format!("{id}.jpg"));
        if file.is_file() {
            conn.execute(
                "UPDATE books SET cover_path = ?1, cover_state = 'ready' WHERE id = ?2",
                params![file.to_string_lossy(), id],
            )?;
        } else {
            // 没有文件就别留着旧路径，否则前端只能是裂图
            conn.execute(
                "UPDATE books SET cover_path = NULL, cover_state = 'pending' WHERE id = ?1",
                params![id],
            )?;
        }
    }
    Ok(())
}

/// 本地备份目录里的包（移动端产物，桌面端也可以指过来）。
pub fn list_local(dir: &Path) -> Vec<LocalBackup> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_zip = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false);
        if !is_zip {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(LocalBackup {
            path: path.to_string_lossy().into_owned(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            bytes: meta.len(),
            created_at,
        });
    }
    // 文件名带时间戳，倒序即可大致等于「最近的在前」
    out.sort_by(|a, b| b.name.cmp(&a.name));
    out
}

// ---------------- 配置 ----------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct WebdavConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    /// 远端子目录，相对 `url`。留空 = 直接放在 url 指向的目录里
    pub dir: String,
    /// 保留最近几份，0 表示不清理
    pub keep: i64,
}

impl Default for WebdavConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            username: String::new(),
            password: String::new(),
            dir: "cenro".into(),
            keep: 5,
        }
    }
}

impl WebdavConfig {
    fn is_configured(&self) -> bool {
        !self.url.trim().is_empty()
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct BackupConfig {
    pub webdav: WebdavConfig,
    /// 是否把封面缩略图一起打包
    pub include_covers: bool,
    pub last_local_at: Option<i64>,
    pub last_webdav_at: Option<i64>,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            webdav: WebdavConfig::default(),
            include_covers: true,
            last_local_at: None,
            last_webdav_at: None,
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("backup.json")
}

pub fn load_config(data_dir: &Path) -> BackupConfig {
    std::fs::read_to_string(config_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 配置里有 WebDAV 密码，明文落盘但只写在本机应用数据目录，
/// Unix 上顺手把权限收到 600。
pub fn save_config(data_dir: &Path, config: &BackupConfig) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = config_path(data_dir);
    std::fs::write(&path, serde_json::to_vec_pretty(config)?)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ---------------- WebDAV ----------------

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn build_client() -> Result<reqwest::blocking::Client> {
    // 桌面走系统 TLS（Windows 上是 schannel）：读系统证书store，
    // 用户装了抓包/加速工具的根证书也能过，不会像内置根列表那样报 UnknownIssuer。
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("cenro/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::Other(format!("无法初始化网络：{e}")))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn build_client() -> Result<reqwest::blocking::Client> {
    // 移动端没有 native-tls，用 rustls + 内置 Mozilla 根证书。
    // 平台证书校验器在 Android 上要额外的 JVM 初始化，这里绕开它。
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();

    reqwest::blocking::Client::builder()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(20))
        .user_agent(concat!("cenro/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AppError::Other(format!("无法初始化网络：{e}")))
}

fn base_url(cfg: &WebdavConfig) -> Result<String> {
    let url = cfg.url.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(AppError::Other("请先填写 WebDAV 服务器地址".into()));
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::Other(
            "服务器地址要以 http:// 或 https:// 开头".into(),
        ));
    }
    Ok(url.to_string())
}

fn dir_segments(cfg: &WebdavConfig) -> Vec<String> {
    cfg.dir
        .trim()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn join(cfg: &WebdavConfig, tail: &str) -> Result<String> {
    let base = base_url(cfg)?;
    let segments = dir_segments(cfg);
    let mut url = base;
    for seg in &segments {
        url.push('/');
        url.push_str(seg);
    }
    if !tail.is_empty() {
        url.push('/');
        url.push_str(tail);
    }
    Ok(url)
}

fn dav_method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).unwrap_or(reqwest::Method::GET)
}

fn status_hint(code: u16) -> &'static str {
    match code {
        400 => "服务器认为请求不合法",
        401 => "认证失败：用户名或密码不对（坚果云等服务需要「应用密码」，不是登录密码）",
        403 => "没有权限：这个账号不能写这个目录",
        404 => "路径不存在：检查地址和远端目录名",
        405 => "服务器不接受这个操作（可能不是 WebDAV 地址）",
        409 => "远端目录不存在，且无法自动创建",
        423 => "文件被占用（另一端正在同步？）",
        429 => "请求太频繁，稍后再试",
        507 => "远端空间不足",
        _ => "服务器返回错误",
    }
}

struct Dav {
    client: reqwest::blocking::Client,
    cfg: WebdavConfig,
}

impl Dav {
    fn new(cfg: &WebdavConfig) -> Result<Self> {
        Ok(Self {
            client: build_client()?,
            cfg: cfg.clone(),
        })
    }

    fn request(&self, method: &str, url: &str) -> reqwest::blocking::RequestBuilder {
        let mut req = self.client.request(dav_method(method), url);
        let user = self.cfg.username.trim();
        if !user.is_empty() {
            req = req.basic_auth(user, Some(self.cfg.password.as_str()));
        }
        req
    }

    fn send(
        &self,
        method: &str,
        url: &str,
        body: Option<Vec<u8>>,
        expect: &[u16],
    ) -> Result<reqwest::blocking::Response> {
        let mut req = self.request(method, url);
        if let Some(body) = body {
            req = req
                .header("Content-Type", "application/xml; charset=utf-8")
                .body(body);
        }
        let resp = req
            .send()
            .map_err(|e| AppError::Other(format!("连不上服务器：{e}")))?;
        let code = resp.status().as_u16();
        if expect.contains(&code) {
            return Ok(resp);
        }
        Err(AppError::Other(format!(
            "{}（{} {}）",
            status_hint(code),
            code,
            resp.status().canonical_reason().unwrap_or("")
        )))
    }

    /// 逐级创建远端目录。已存在的层级返回 405，忽略即可。
    fn ensure_dir(&self) -> Result<()> {
        let base = base_url(&self.cfg)?;
        let segments = dir_segments(&self.cfg);
        if segments.is_empty() {
            return Ok(());
        }
        let mut cur = base;
        for seg in segments {
            cur.push('/');
            cur.push_str(&seg);
            let resp = self.request("MKCOL", &cur).send().map_err(|e| {
                AppError::Other(format!("连不上服务器：{e}"))
            })?;
            let code = resp.status().as_u16();
            match code {
                200 | 201 | 204 | 301 | 405 => {} // 建成 / 已存在
                _ => {
                    return Err(AppError::Other(format!(
                        "无法创建远端目录：{}（{}）",
                        status_hint(code),
                        code
                    )))
                }
            }
        }
        Ok(())
    }

    fn list(&self) -> Result<Vec<RemoteBackup>> {
        // 集合地址必须以斜杠结尾：少了它，多数服务器会 301 到带斜杠的地址，
        // 而 PROPFIND 被重定向后通常变成 GET，拿回来的就不是 multistatus 了。
        let url = format!("{}/", join(&self.cfg, "")?);
        let body = br#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>
</d:prop></d:propfind>"#
            .to_vec();

        let mut req = self.request("PROPFIND", &url);
        req = req
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body);
        let resp = req
            .send()
            .map_err(|e| AppError::Other(format!("连不上服务器：{e}")))?;

        let code = resp.status().as_u16();
        if code == 404 {
            return Ok(Vec::new()); // 还没建过，等于没有备份
        }
        if !(200..300).contains(&code) {
            return Err(AppError::Other(format!(
                "{}（{}）",
                status_hint(code),
                code
            )));
        }

        let text = resp.text().unwrap_or_default();
        Ok(parse_listing(&text))
    }

    fn delete(&self, name: &str) -> Result<()> {
        let url = join(&self.cfg, name)?;
        let resp = self.request("DELETE", &url).send().map_err(|e| {
            AppError::Other(format!("连不上服务器：{e}"))
        })?;
        let code = resp.status().as_u16();
        if (200..300).contains(&code) || code == 404 {
            Ok(())
        } else {
            Err(AppError::Other(format!(
                "删除失败：{}（{}）",
                status_hint(code),
                code
            )))
        }
    }

    fn download(&self, name: &str, target: &Path) -> Result<()> {
        let url = join(&self.cfg, name)?;
        let resp = self.send("GET", &url, None, &[200])?;
        let bytes = resp
            .bytes()
            .map_err(|e| AppError::Other(format!("下载中断：{e}")))?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(target, &bytes)?;
        Ok(())
    }
}

/// 解析 PROPFIND 的 multistatus。只取「不是集合、且以 .zip 结尾」的条目。
fn parse_listing(xml: &str) -> Vec<RemoteBackup> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };

    let name_of = |node: roxmltree::Node<'_, '_>, tag: &str| -> Option<String> {
        node.descendants()
            .find(|n| n.is_element() && n.tag_name().name() == tag)
            .and_then(|n| n.text())
            .map(|t| t.trim().to_string())
    };

    let mut out = Vec::new();
    for node in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "response")
    {
        let is_collection = node
            .descendants()
            .any(|n| n.is_element() && n.tag_name().name() == "collection");
        if is_collection {
            continue;
        }
        let Some(href) = name_of(node, "href") else {
            continue;
        };
        let decoded = href.trim_end_matches('/');
        let Some(name) = decoded.rsplit('/').next() else {
            continue;
        };
        if !name.to_ascii_lowercase().ends_with(".zip") {
            continue;
        }
        let bytes = name_of(node, "getcontentlength")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let modified = name_of(node, "getlastmodified").unwrap_or_default();
        out.push(RemoteBackup {
            name: name.to_string(),
            bytes,
            modified,
        });
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    out
}

/// 试连：建目录 + 列一次目录。两个动词都通了才算「能用」，只做 HEAD 会漏掉写权限问题。
pub fn webdav_test(cfg: &WebdavConfig) -> Result<String> {
    if !cfg.is_configured() {
        return Err(AppError::Other("请先填写服务器地址".into()));
    }
    let dav = Dav::new(cfg)?;
    dav.ensure_dir()?;
    let files = dav.list()?;
    let dir = dir_segments(cfg).join("/");
    Ok(format!(
        "连接成功 · 远端目录「{}」可用，已有 {} 份备份",
        if dir.is_empty() { "/".into() } else { dir },
        files.len()
    ))
}

/// 备份并上传。返回远端地址。
pub fn webdav_upload(
    conn: &Connection,
    cover_dir: &Path,
    cfg: &WebdavConfig,
    include_covers: bool,
    include_private: bool,
    app_version: &str,
) -> Result<ExportReport> {
    let dav = Dav::new(cfg)?;
    dav.ensure_dir()?;

    // 先在本地临时目录生成，上传完就删：用户没要「留一份在本机」
    let name = backup_file_name();
    let tmp = temp_path("cenro-upload", "dir");
    std::fs::create_dir_all(&tmp)?;
    let archive = tmp.join(&name);
    let report = export(
        conn,
        cover_dir,
        &archive,
        include_covers,
        include_private,
        app_version,
    )?;

    let url = join(cfg, &name)?;
    let body = std::fs::read(&archive)?;
    let resp = dav
        .request("PUT", &url)
        .header("Content-Type", "application/zip")
        .body(body)
        .send()
        .map_err(|e| AppError::Other(format!("上传失败：{e}")))?;
    let code = resp.status().as_u16();
    let _ = std::fs::remove_dir_all(&tmp);

    if !(200..300).contains(&code) {
        return Err(AppError::Other(format!(
            "上传失败：{}（{}）",
            status_hint(code),
            code
        )));
    }

    // 只保留最近 keep 份。清旧失败不该让整次备份算失败——包已经传上去了。
    if cfg.keep > 0 {
        let keep = cfg.keep.clamp(1, 50) as usize;
        if let Ok(files) = dav.list() {
            for old in files.iter().skip(keep) {
                let _ = dav.delete(&old.name);
            }
        }
    }

    Ok(ExportReport {
        path: url,
        ..report
    })
}

pub fn webdav_list(cfg: &WebdavConfig) -> Result<Vec<RemoteBackup>> {
    Dav::new(cfg)?.list()
}

pub fn webdav_delete(cfg: &WebdavConfig, name: &str) -> Result<()> {
    Dav::new(cfg)?.delete(name)
}

/// 从云端下载到临时文件再走本地恢复流程。
pub fn webdav_restore(
    conn: &mut Connection,
    cover_dir: &Path,
    cfg: &WebdavConfig,
    name: &str,
) -> Result<RestoreReport> {
    let dav = Dav::new(cfg)?;
    let tmp = temp_path("cenro-download", "zip");
    dav.download(name, &tmp)?;
    let result = restore(conn, cover_dir, &tmp);
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Book, BookFormat, BookType, CoverState};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cenro-backup-test-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seeded_db(dir: &Path) -> Connection {
        let conn = Connection::open(dir.join("cenro.db")).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        db::init(&conn).unwrap();
        db::upsert_book(
            &conn,
            &Book {
                id: "b1".into(),
                book_type: BookType::Novel,
                format: BookFormat::Txt,
                path: dir.join("a.txt").to_string_lossy().into_owned(),
                size: 1,
                mtime: 0,
                title: "备份测试".into(),
                author: None,
                cover_path: None,
                cover_state: CoverState::Pending,
                meta_locked: false,
                status: crate::models::BookStatus::Ok,
                private: false,
                missing: false,
                progress: None,
                metadata: None,
                added_at: 1,
                last_read_at: None,
            },
        )
        .unwrap();
        conn
    }

    /// 导出 → 清空库 → 恢复，书要回来。这条链路是备份功能唯一的承诺。
    #[test]
    fn export_then_restore_roundtrip() {
        let dir = temp_dir("roundtrip");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        std::fs::write(covers.join("b1.jpg"), b"fake-jpeg").unwrap();

        let mut conn = seeded_db(&dir);
        let archive = dir.join("backup.zip");
        let report = export(&conn, &covers, &archive, true, false, "0.0.0-test").unwrap();
        assert_eq!(report.books, 1);
        assert_eq!(report.covers, 1);
        assert!(archive.is_file());

        // 模拟「换了台机器」：记录清空，封面目录在别处
        conn.execute("DELETE FROM books", []).unwrap();
        assert_eq!(db::count_books(&conn).unwrap(), 0);
        let other_covers = dir.join("covers2");
        std::fs::create_dir_all(&other_covers).unwrap();

        let restored = restore(&mut conn, &other_covers, &archive).unwrap();
        assert_eq!(restored.books, 1);
        assert_eq!(restored.covers, 1);

        let book = db::get_book(&conn, "b1").unwrap().unwrap();
        assert_eq!(book.title, "备份测试");
        // 关键：cover_path 必须重指到本机目录，不能留着备份机器的绝对路径
        assert_eq!(
            book.cover_path.as_deref(),
            Some(other_covers.join("b1.jpg").to_string_lossy().as_ref())
        );
        assert_eq!(book.cover_state, CoverState::Ready);
    }

    /// 备份不含隐私书时，它的标注也不能跟着走。
    #[test]
    fn export_without_private_drops_their_annotations() {
        let dir = temp_dir("private-notes");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();

        let conn = seeded_db(&dir);
        seed_book(&conn, &dir, "p1", "私密书", true);
        for id in ["b1", "p1"] {
            db::insert_annotation(
                &conn,
                &crate::models::Annotation {
                    id: format!("note-{id}"),
                    book_id: id.to_string(),
                    kind: crate::models::AnnotationKind::Bookmark,
                    locator: crate::models::Progress::Text {
                        offset: 0,
                        chapter: 0,
                        total: 100,
                    },
                    label: Some(format!("{id} 的备注")),
                    excerpt: None,
                    anchor: None,
                    created_at: 1,
                    updated_at: 1,
                },
            )
            .unwrap();
        }

        let archive = dir.join("backup.zip");
        export(&conn, &covers, &archive, false, false, "0.0.0-test").unwrap();

        // 直接打开包里的数据库核对
        let file = std::fs::File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut entry = zip.by_name(DB_ENTRY).unwrap();
        let out = dir.join("check.db");
        let mut f = std::fs::File::create(&out).unwrap();
        std::io::copy(&mut entry, &mut f).unwrap();
        drop(f);

        let snapshot = Connection::open(&out).unwrap();
        let left: i64 = snapshot
            .query_row("SELECT COUNT(*) FROM annotations WHERE book_id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "私密书的标注不应进入备份");
        let kept: i64 = snapshot
            .query_row("SELECT COUNT(*) FROM annotations WHERE book_id = 'b1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "普通书的标注要保留");
    }

    fn seed_book(conn: &Connection, dir: &Path, id: &str, title: &str, private: bool) {
        db::upsert_book(
            conn,
            &Book {
                id: id.into(),
                book_type: BookType::Novel,
                format: BookFormat::Txt,
                path: dir.join(format!("{id}.txt")).to_string_lossy().into_owned(),
                size: 1,
                mtime: 0,
                title: title.into(),
                author: None,
                cover_path: None,
                cover_state: CoverState::Pending,
                meta_locked: false,
                status: crate::models::BookStatus::Ok,
                private,
                missing: false,
                progress: None,
                metadata: None,
                added_at: 1,
                last_read_at: None,
            },
        )
        .unwrap();
        if private {
            // upsert_book 有意不写 private 列（见 db.rs 的注释），标记要单独打
            db::set_private(conn, id, true).unwrap();
        }
    }

    /// 直接拆包看里面的库：总数 + 隐私书数。备份功能的承诺要在这里落地，
    /// 「代码里写了 DELETE」不算证明。
    fn inspect_archive(archive: &Path) -> (i64, i64, usize) {
        let file = std::fs::File::open(archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let covers = (0..zip.len())
            .filter(|i| {
                zip.by_index(*i)
                    .map(|f| {
                        f.name()
                            .map(|n| n.starts_with(COVER_PREFIX))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false)
            })
            .count();

        let tmp = temp_path("cenro-inspect", "db");
        {
            let mut entry = zip.by_name(DB_ENTRY).unwrap();
            let mut out = std::fs::File::create(&tmp).unwrap();
            std::io::copy(&mut entry, &mut out).unwrap();
        }
        let conn = Connection::open(&tmp).unwrap();
        let total = conn
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        let private = conn
            .query_row("SELECT COUNT(*) FROM books WHERE private = 1", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        let _ = std::fs::remove_file(&tmp);
        (total, private, covers)
    }

    /// 默认不备份隐私书：库里 2 本（1 本隐私），包里只剩 1 本，封面也只跟 1 张走。
    ///
    /// 这条是「选择否」的分支，也是所有调用方的默认值——默认必须安全。
    #[test]
    fn export_excludes_private_books_by_default() {
        let dir = temp_dir("exclude-private");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        // 封面文件名就是 `{book_id}.jpg`：id 是 b1（公开）与 hid（隐私）
        std::fs::write(covers.join("b1.jpg"), b"pub-jpeg").unwrap();
        std::fs::write(covers.join("hid.jpg"), b"hid-jpeg").unwrap();

        let conn = seeded_db(&dir); // 内含 b1
        seed_book(&conn, &dir, "hid", "私密书", true);
        db::set_private(&conn, "b1", false).unwrap();

        let archive = dir.join("backup.zip");
        let report = export(&conn, &covers, &archive, true, false, "0.0.0-test").unwrap();
        assert_eq!(report.books, 1, "报告里的数量要反映包内实际内容");
        assert_eq!(report.private_books, 0);

        let (total, private, cover_count) = inspect_archive(&archive);
        assert_eq!(total, 1, "隐私书不能进包");
        assert_eq!(private, 0);
        assert_eq!(cover_count, 1, "隐私书的封面也不该跟着走");

        // 原始库不受影响
        assert_eq!(db::count_books(&conn).unwrap(), 2);
        assert_eq!(db::count_private(&conn).unwrap(), 1);
    }

    /// 用户选「一并备份」时全带上，恢复回来 private 标记仍在
    #[test]
    fn export_includes_private_when_asked() {
        let dir = temp_dir("include-private");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        std::fs::write(covers.join("b1.jpg"), b"a").unwrap();
        std::fs::write(covers.join("hid.jpg"), b"b").unwrap();

        let mut conn = seeded_db(&dir);
        seed_book(&conn, &dir, "hid", "私密书", true);

        let archive = dir.join("backup.zip");
        let report = export(&conn, &covers, &archive, true, true, "0.0.0-test").unwrap();
        assert_eq!(report.books, 2);
        assert_eq!(report.private_books, 1);

        let (total, private, _) = inspect_archive(&archive);
        assert_eq!((total, private), (2, 1));

        conn.execute("DELETE FROM books", []).unwrap();
        let restored = restore(&mut conn, &covers, &archive).unwrap();
        assert_eq!(restored.books, 2);
        assert_eq!(restored.private_books, 1, "恢复后隐私标记必须还原");
    }

    /// 备份范围：前端据此决定要不要弹「是否一并备份」
    #[test]
    fn scope_counts_private_books() {
        let dir = temp_dir("scope");
        let conn = seeded_db(&dir);
        assert_eq!(scope(&conn).unwrap().private_books, 0);

        seed_book(&conn, &dir, "hid", "私密书", true);
        let s = scope(&conn).unwrap();
        assert_eq!(s.books, 2);
        assert_eq!(s.private_books, 1);
    }

    /// 不含封面的包恢复后，封面状态要退回 pending 而不是留死链
    #[test]
    fn restore_without_covers_resets_cover_state() {
        let dir = temp_dir("nocover");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        std::fs::write(covers.join("b1.jpg"), b"fake").unwrap();

        let mut conn = seeded_db(&dir);
        conn.execute(
            "UPDATE books SET cover_path = '/old/machine/b1.jpg', cover_state = 'ready'",
            [],
        )
        .unwrap();

        let archive = dir.join("backup.zip");
        export(&conn, &covers, &archive, false, false, "0.0.0-test").unwrap();
        assert_eq!(restore(&mut conn, &covers, &archive).unwrap().covers, 0);

        let book = db::get_book(&conn, "b1").unwrap().unwrap();
        assert!(book.cover_path.is_none());
        assert_eq!(book.cover_state, CoverState::Pending);
    }

    /// 别的 zip（比如随手把一本书改名）不能被当成备份解开
    #[test]
    fn rejects_foreign_zip() {
        let dir = temp_dir("foreign");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        let mut conn = seeded_db(&dir);

        let archive = dir.join("book.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        zw.start_file("chapter1.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(b"hello").unwrap();
        zw.finish().unwrap();

        let err = restore(&mut conn, &covers, &archive).unwrap_err();
        assert!(err.to_string().contains("备份包"), "错误信息要说清不是备份包");
        assert_eq!(db::count_books(&conn).unwrap(), 1, "失败时不能动现有数据");
    }

    /// 配置里有密码，读回来必须原样（否则每次都要重填）
    #[test]
    fn config_roundtrip() {
        let dir = temp_dir("config");
        let mut cfg = BackupConfig::default();
        cfg.webdav.url = "https://dav.example.com/dav".into();
        cfg.webdav.username = "u".into();
        cfg.webdav.password = "p@ss/word".into();
        cfg.webdav.keep = 3;
        save_config(&dir, &cfg).unwrap();

        let loaded = load_config(&dir);
        assert_eq!(loaded.webdav.url, cfg.webdav.url);
        assert_eq!(loaded.webdav.password, cfg.webdav.password);
        assert_eq!(loaded.webdav.keep, 3);
        assert!(loaded.include_covers, "默认要带上封面");
    }

    /// 缺字段的旧配置不能整体失效（否则用户一升级就丢地址）
    #[test]
    fn config_tolerates_missing_fields() {
        let dir = temp_dir("config-old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            config_path(&dir),
            br#"{"webdav":{"url":"https://dav.example.com","dir":"bak"}}"#,
        )
        .unwrap();
        let cfg = load_config(&dir);
        assert_eq!(cfg.webdav.url, "https://dav.example.com");
        assert_eq!(cfg.webdav.keep, 5, "缺 keep 时给默认值");
        assert!(cfg.webdav.username.is_empty());
    }

    /// PROPFIND 响应里带集合、带非 zip 文件时只能挑出我们的备份
    #[test]
    fn parses_propfind_listing() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/cenro/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/cenro/cenro-backup-20261115-1010.zip</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>2048</d:getcontentlength>
      <d:getlastmodified>Sat, 15 Nov 2026 02:10:00 GMT</d:getlastmodified></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/cenro/notes.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>3</d:getcontentlength></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"#;

        let files = parse_listing(xml);
        assert_eq!(files.len(), 1, "只要 zip，且目录本身不算");
        assert_eq!(files[0].name, "cenro-backup-20261115-1010.zip");
        assert_eq!(files[0].bytes, 2048);
        assert!(files[0].modified.contains("2026"));
    }

    /// 真实跑一遍 WebDAV：建目录 → 上传 → 列表 → 只留一份 → 下载恢复 → 删除。
    ///
    /// 需要外部服务，默认跳过。本地用法：
    /// `python scripts/dav-test-server.py /tmp/dav 8765`
    /// `CENRO_DAV_URL=http://127.0.0.1:8765/dav cargo test --lib webdav_smoke -- --ignored`
    #[test]
    #[ignore]
    fn webdav_smoke() {
        let Ok(url) = std::env::var("CENRO_DAV_URL") else {
            return;
        };
        let dir = temp_dir("dav-smoke");
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        std::fs::write(covers.join("b1.jpg"), b"fake-jpeg").unwrap();

        let mut conn = seeded_db(&dir);
        let cfg = WebdavConfig {
            url,
            username: "test".into(),
            password: "test".into(),
            dir: "cenro".into(),
            keep: 1,
        };

        let msg = webdav_test(&cfg).unwrap();
        assert!(msg.contains("连接成功"), "{msg}");

        let first = webdav_upload(&conn, &covers, &cfg, true, false, "0.0.0-test").unwrap();
        assert_eq!(first.books, 1);
        assert!(first.path.ends_with(".zip"), "{}", first.path);

        let files = webdav_list(&cfg).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].bytes > 0, "长度要从 PROPFIND 里读到");

        // 秒级时间戳：等一秒才有第二个文件名
        std::thread::sleep(std::time::Duration::from_millis(1100));
        webdav_upload(&conn, &covers, &cfg, true, false, "0.0.0-test").unwrap();
        let files = webdav_list(&cfg).unwrap();
        assert_eq!(files.len(), 1, "keep=1 应当把旧的那份清掉");

        // 清库再从云端恢复
        conn.execute("DELETE FROM books", []).unwrap();
        let restored = webdav_restore(&mut conn, &covers, &cfg, &files[0].name).unwrap();
        assert_eq!(restored.books, 1);
        assert_eq!(db::get_book(&conn, "b1").unwrap().unwrap().title, "备份测试");

        webdav_delete(&cfg, &files[0].name).unwrap();
        assert!(webdav_list(&cfg).unwrap().is_empty());
    }

    /// 地址拼接：末尾斜杠、目录前后的斜杠都吃掉，不能拼出 `//`
    #[test]
    fn joins_url_and_dir() {
        let mut cfg = WebdavConfig::default();
        cfg.url = "https://dav.example.com/dav/".into();
        cfg.dir = "/cenro/bak/".into();
        assert_eq!(
            join(&cfg, "x.zip").unwrap(),
            "https://dav.example.com/dav/cenro/bak/x.zip"
        );
        cfg.dir = String::new();
        assert_eq!(
            join(&cfg, "x.zip").unwrap(),
            "https://dav.example.com/dav/x.zip"
        );
        cfg.url = "dav.example.com".into();
        assert!(join(&cfg, "").is_err(), "缺协议要直接说清楚");
    }
}
