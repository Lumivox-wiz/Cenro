//! 隐私书架（P1）。
//!
//! 这一版只做**可见性隔离**，不做内容加密：
//!
//! - 书架、搜索、统计默认看不见隐私书（`books_visible` 视图，fail-closed）
//! - 按 id 打开的命令在会话未解锁时统一返回「书不存在」，不返回 403
//!   —— 403 等于告诉对方「这本书存在，只是不给你看」
//! - 封面挪到 `private_covers/`，不在普通封面目录里躺着
//! - 备份默认排除（见 `backup.rs`）
//!
//! **没有做到的**：文件还在磁盘上、标题仍以文件名存在、导出/截图不受控。
//! 这一层挡的是「别人拿起你的设备翻两下」，挡不住任何懂电脑的人。界面上必须如实写。
//!
//! PIN 用 Argon2id 存 PHC 字符串。6 位数字离线爆破本来就不难，
//! 所以这里的目标不是「抗暴力」，而是「别把 PIN 明文/弱哈希留在磁盘上」。

use crate::error::{AppError, Result};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, SaltString};
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// PIN 固定 6 位数字。太短会被随手猜中，太长则每次解锁都烦。
pub const PIN_LEN: usize = 6;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct PrivacyConfig {
    pub enabled: bool,
    /// Argon2id 的 PHC 字符串（盐已成对包含在里面）
    pub pin_hash: String,
    /// 空闲多少分钟后自动上锁，0 表示不自动锁
    pub lock_after_minutes: i64,
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            pin_hash: String::new(),
            lock_after_minutes: 5,
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("privacy.json")
}

pub fn load(data_dir: &Path) -> PrivacyConfig {
    std::fs::read_to_string(config_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(data_dir: &Path, config: &PrivacyConfig) -> Result<()> {
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

pub fn hash_pin(pin: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pin.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Other(format!("无法保存 PIN：{e}")))
}

pub fn verify_pin(pin: &str, phc: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(phc) else {
        return false;
    };
    Argon2::default()
        .verify_password(pin.as_bytes(), &parsed)
        .is_ok()
}

/// 只接受 6 位纯数字。前端已经限制输入，这里再挡一次：
/// 密码学上 4 位和 6 位的差别没那么大，但「能输字母的 PIN」会让人以为它更安全。
pub fn normalize_pin(pin: &str) -> Result<String> {
    let trimmed = pin.trim();
    if trimmed.len() != PIN_LEN || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::Other(format!("PIN 需要 {PIN_LEN} 位数字")));
    }
    Ok(trimmed.to_string())
}

/// 解锁会话。**只在内存里**，不落盘、不进 localStorage：
/// 应用被杀掉就自动锁上，这是最省事也最可靠的「上锁」。
pub struct Session {
    unlocked_at: Option<Instant>,
    /// 连续失败次数，用于退避
    failures: u32,
    blocked_until: Option<Instant>,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            unlocked_at: None,
            failures: 0,
            blocked_until: None,
        }
    }
}

impl Session {
    pub fn unlock(&mut self) {
        self.unlocked_at = Some(Instant::now());
        self.failures = 0;
        self.blocked_until = None;
    }

    pub fn lock(&mut self) {
        self.unlocked_at = None;
    }

    /// 是否处于解锁态。`lock_after_minutes = 0` 表示本次会话不自动过期。
    pub fn is_unlocked(&self, lock_after_minutes: i64) -> bool {
        let Some(at) = self.unlocked_at else {
            return false;
        };
        if lock_after_minutes <= 0 {
            return true;
        }
        at.elapsed() < Duration::from_secs(lock_after_minutes as u64 * 60)
    }

    /// 还要等多久才能再试一次。0 表示可以立刻试。
    pub fn retry_after(&self) -> Duration {
        match self.blocked_until {
            Some(t) if t > Instant::now() => t - Instant::now(),
            _ => Duration::ZERO,
        }
    }

    /// 记一次失败。前 4 次不惩罚（打错很正常），之后 2^n 秒退避，封顶 30 秒。
    ///
    /// 刻意**不锁死**：本地应用没有找回通道，锁死等于让用户自伤，
    /// 而真正的攻击者面对的是磁盘上的哈希，不在这里。
    pub fn record_failure(&mut self) {
        self.failures = self.failures.saturating_add(1);
        if self.failures > 4 {
            let exp = (self.failures - 5).min(5);
            let secs = (1u64 << exp).min(30);
            self.blocked_until = Some(Instant::now() + Duration::from_secs(secs));
        }
    }

    pub fn reset_failures(&mut self) {
        self.failures = 0;
        self.blocked_until = None;
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_roundtrip() {
        let pin = normalize_pin("123456").unwrap();
        let hash = hash_pin(&pin).unwrap();
        assert!(hash.starts_with("$argon2"), "{hash}");
        assert!(verify_pin("123456", &hash));
        assert!(!verify_pin("123457", &hash));
        // 同一 PIN 两次哈希必须不同（盐随机）
        assert_ne!(hash, hash_pin("123456").unwrap());
    }

    #[test]
    fn rejects_bad_pins() {
        assert!(normalize_pin("12345").is_err());
        assert!(normalize_pin("1234567").is_err());
        assert!(normalize_pin("12345a").is_err());
        assert!(normalize_pin("").is_err());
    }

    #[test]
    fn corrupted_hash_never_verifies() {
        assert!(!verify_pin("123456", ""));
        assert!(!verify_pin("123456", "not-a-phc-string"));
    }

    #[test]
    fn session_locks_and_expires() {
        let mut s = Session::default();
        assert!(!s.is_unlocked(5));
        s.unlock();
        assert!(s.is_unlocked(5));
        assert!(s.is_unlocked(0), "0 表示不自动锁");

        s.lock();
        assert!(!s.is_unlocked(0));
    }

    #[test]
    fn backoff_starts_after_four_misses() {
        let mut s = Session::default();
        for _ in 0..4 {
            s.record_failure();
        }
        assert_eq!(s.retry_after(), Duration::ZERO, "前 4 次不该罚");
        s.record_failure();
        assert!(s.retry_after() > Duration::ZERO);

        // 成功一次就清零，不会把正常的打错累积成惩罚
        s.unlock();
        assert_eq!(s.failures(), 0);
        assert_eq!(s.retry_after(), Duration::ZERO);
    }

    #[test]
    fn config_roundtrip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("cenro-privacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let cfg = PrivacyConfig {
            enabled: true,
            pin_hash: hash_pin("000000").unwrap(),
            lock_after_minutes: 15,
        };
        save(&dir, &cfg).unwrap();

        let loaded = load(&dir);
        assert!(loaded.enabled);
        assert!(verify_pin("000000", &loaded.pin_hash));
        assert_eq!(loaded.lock_after_minutes, 15);

        // 没有文件时给默认值而不是报错
        let empty = std::env::temp_dir().join(format!("cenro-privacy-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        let fallback = load(&empty);
        assert!(!fallback.enabled);
        assert_eq!(fallback.lock_after_minutes, 5);
    }
}
