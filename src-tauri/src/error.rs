use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("文件读写错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("压缩包错误: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("图像处理错误: {0}")]
    Image(#[from] image::ImageError),
    #[error("数据序列化错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("解析失败: {0}")]
    Parse(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
