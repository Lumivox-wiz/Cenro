use crate::error::Result;
use crate::models::{
    Anchor, Annotation, AnnotationKind, Book, BookFormat, BookStatus, BookType, CoverState,
    LibraryRoot, Progress, TagCount,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS books (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  format        TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  size          INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  title         TEXT NOT NULL,
  author        TEXT,
  cover_path    TEXT,
  cover_state   TEXT NOT NULL DEFAULT 'pending',
  meta_locked   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ok',
  private       INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT,
  metadata_json TEXT,
  added_at      INTEGER NOT NULL,
  last_read_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_books_type      ON books(type);
CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_mtime     ON books(path, mtime);

/*
 * 标注。三样东西共用一张表：书签 / 高亮 / 笔记。
 *
 * 位置存 `Progress` 的 JSON（locator_json），与阅读进度同构——
 * 「跳到书签」和「跳到搜索结果」因此是同一段跳转代码。
 * ON DELETE CASCADE 让删书时自动清掉标注，不用在删除逻辑里再记一笔。
 */
CREATE TABLE IF NOT EXISTS annotations (
  id           TEXT PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  label        TEXT,
  excerpt      TEXT,
  anchor_json  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id, created_at DESC);

/*
 * 标签：与「分类」正交的另一根轴。
 * 分类由格式决定（一本书只能落一格），标签是用户自己贴的（一本书可以有多个）——
 * 「工作资料 + 待读」「闲书 + 睡前」这种组合，靠分类永远表达不出来。
 *
 * 名字直接当主键：标签没有独立生命周期，改名等于删一个建一个，
 * 省掉一层 id 映射。大小写按原样保留，不做归一化——中文场景用不上，
 * 英文混用大小写属于用户自己的选择。
 */
CREATE TABLE IF NOT EXISTS tags (
  name       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_tags (
  book_id  TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (book_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_book_tags_tag ON book_tags(tag);

CREATE TABLE IF NOT EXISTS library_roots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  path     TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL
);
"#;

/// 表里有没有某一列。用于迁移时决定能不能按名拷贝（`PRAGMA table_info`）。
fn has_column(conn: &Connection, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare("PRAGMA table_info(books)") else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) else {
        return false;
    };
    rows.flatten().any(|name| name == column)
}

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/*
 * v0.9.0 新增了书籍类型「文档」（OFD / Excel），但旧库的 `books.type` 上还留着
 * `CHECK (type IN ('novel','comic','pdf'))`。SQLite 不能就地改 CHECK，只能重建表。
 *
 * 不报错的后果是：扫描阶段 `upsert_book` 直接失败，而扫描器的错误被吞成「失败 N 个」，
 * 用户只看到导入失败、不知道原因。
 *
 * 重建时用显式列名：老库的 `meta_locked` / `status` 是 ALTER 加上去的，排在表尾，
 * `SELECT *` 的顺序与新表不一致，会串列。
 */
fn migrate_relax_type_check(conn: &Connection) -> Result<()> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='books'",
            [],
            |row| row.get(0),
        )
        .optional()?;

    let Some(sql) = sql else {
        return Ok(()); // 全新库还没建表，由 SCHEMA 负责
    };
    if !sql.contains("CHECK(type IN") {
        return Ok(());
    }

    /*
     * 列清单要按旧表实际情况拼：极老的库既没有 private，也可能没有 status。
     * 硬编码一份清单会在「列不存在」时直接报错，迁移失败用户只会看到「导入失败」。
     */
    const COLUMNS: &str = "id, type, format, path, size, mtime, title, author, cover_path, \
                           cover_state, meta_locked, status, private, progress_json, \
                           metadata_json, added_at, last_read_at";
    let private_expr = if has_column(conn, "private") { "private" } else { "0" };
    let source = COLUMNS.replace(", private,", &format!(", {private_expr},"));

    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let migrated = conn.execute_batch(&format!(
        "BEGIN;
         CREATE TABLE books_new (
           id            TEXT PRIMARY KEY,
           type          TEXT NOT NULL,
           format        TEXT NOT NULL,
           path          TEXT NOT NULL UNIQUE,
           size          INTEGER NOT NULL,
           mtime         INTEGER NOT NULL,
           title         TEXT NOT NULL,
           author        TEXT,
           cover_path    TEXT,
           cover_state   TEXT NOT NULL DEFAULT 'pending',
           meta_locked   INTEGER NOT NULL DEFAULT 0,
           status        TEXT NOT NULL DEFAULT 'ok',
           private       INTEGER NOT NULL DEFAULT 0,
           progress_json TEXT,
           metadata_json TEXT,
           added_at      INTEGER NOT NULL,
           last_read_at  INTEGER
         );
         INSERT INTO books_new ({COLUMNS}) SELECT {source} FROM books;
         DROP TABLE books;
         ALTER TABLE books_new RENAME TO books;
         COMMIT;"
    ));
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    migrated?;
    Ok(())
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;

    // 兼容旧库：新列用 ALTER 补上。列已存在时会报错，忽略即可。
    let _ = conn.execute(
        "ALTER TABLE books ADD COLUMN meta_locked INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE books ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'",
        [],
    );
    // 隐私书架。P1 只做可见性隔离：列 + 备份排除 + 扫描不重置
    let _ = conn.execute(
        "ALTER TABLE books ADD COLUMN private INTEGER NOT NULL DEFAULT 0",
        [],
    );

    migrate_relax_type_check(conn)?;

    /*
     * 高亮锚点。老库的 annotations 表没有这一列，
     * `SELECT *` 会少字段，所以必须补上再读——否则所有老标注都读不出来。
     */
    let _ = conn.execute("ALTER TABLE annotations ADD COLUMN anchor_json TEXT", []);

    /*
     * 两个视图把「公开 / 隐私」变成查询入口而不是条件记忆：
     * 列表、统计、搜索一律查视图，将来新增查询也不会漏掉 private = 0。
     * 写操作仍然对着 `books` 表——视图默认不可写，这是好事，
     * 避免有人以为往视图里 INSERT 就能加书。
     */
    conn.execute_batch(
        "CREATE VIEW IF NOT EXISTS books_visible AS SELECT * FROM books WHERE private = 0;
         CREATE VIEW IF NOT EXISTS books_private AS SELECT * FROM books WHERE private = 1;",
    )?;

    // 重建表会连带删掉旧索引，这里补一次（都是 IF NOT EXISTS，幂等）
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_books_type      ON books(type);
         CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
         CREATE INDEX IF NOT EXISTS idx_books_mtime     ON books(path, mtime);",
    )?;
    Ok(())
}

/* ---------------- 路径修复 ---------------- */

/// 把库里记录的绝对路径从旧前缀换到新前缀，返回改了几条。
///
/// 用在哪：数据目录改名（`com.lumviox.cenro` → `com.lumivox.cenro`）之后。
/// 目录一 `rename`，库里那些**绝对路径**（`inbox/` 里的副本、随包说明、封面）
/// 就全部指向不存在的旧目录，书架上表现为整片「文件已丢失」——
/// 文件其实好好躺在新目录里，只是记录没跟着走。
///
/// 比对时统一小写：Windows 路径大小写不敏感，同一条路径可能存成不同写法。
pub fn rewrite_path_prefix(conn: &Connection, old_prefix: &str, new_prefix: &str) -> Result<usize> {
    if old_prefix.is_empty() || new_prefix.is_empty() || old_prefix == new_prefix {
        return Ok(0);
    }
    let old_lower = old_prefix.to_lowercase();

    let mut stmt = conn.prepare("SELECT id, path, cover_path FROM books")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;

    let mut fixes: Vec<(String, String, Option<String>)> = Vec::new();
    for row in rows {
        let (id, path, cover) = row?;
        let new_path = match re_prefixed(&path, &old_lower, old_prefix, new_prefix) {
            Some(p) => p,
            None => continue,
        };
        let new_cover = cover
            .as_deref()
            .and_then(|c| re_prefixed(c, &old_lower, old_prefix, new_prefix));
        fixes.push((id, new_path, new_cover));
    }

    for (id, path, cover) in &fixes {
        conn.execute(
            "UPDATE books SET path = ?1, cover_path = COALESCE(?2, cover_path), status = 'ok' WHERE id = ?3",
            params![path, cover, id],
        )?;
    }
    Ok(fixes.len())
}

/// `path` 以 `old_prefix`（已小写）开头时，换成 `new_prefix` + 剩余部分。
fn re_prefixed(path: &str, old_lower: &str, old_prefix: &str, new_prefix: &str) -> Option<String> {
    if !path.to_lowercase().starts_with(old_lower) {
        return None;
    }
    // 前缀是 ASCII 路径，按字节切安全；长度取原串里实际匹配到的那一段
    let rest = &path[old_prefix.len()..];
    Some(format!("{new_prefix}{rest}"))
}

/* ---------------- 标签 ---------------- */

/// 标签 + 可见书里的使用次数。
///
/// 计数只数公开书架：隐私书的标签如果出现在计数里，
/// 「隐私书完全看不到」这条就被一个数字捅破了。
pub fn list_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT t.name, COUNT(b.id) AS n
           FROM tags t
           LEFT JOIN book_tags bt ON bt.tag = t.name
           LEFT JOIN books b ON b.id = bt.book_id AND b.private = 0
          GROUP BY t.name
          ORDER BY n DESC, t.name ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount {
            name: r.get(0)?,
            count: r.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    // 一条都没挂上的标签不占位置：它们只是「曾经用过」，不是分类
    out.retain(|t| t.count > 0);
    Ok(out)
}

/// 每本书挂了哪些标签。一次取全量，前端建 Map——
/// 书架上几百本书逐个查会打出几百次 IPC。
pub fn list_tag_assignments(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT bt.book_id, bt.tag
           FROM book_tags bt
           JOIN books b ON b.id = bt.book_id
          WHERE b.private = 0
          ORDER BY bt.added_at ASC",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 覆盖一本书的标签集合（全量替换）。返回实际写入的标签，按规范化后顺序。
///
/// 全量替换比为标签做增删接口简单得多：调用方只有一个输入框，
/// 它知道的永远是「这张卡现在有哪些标签」。
pub fn set_book_tags(conn: &Connection, book_id: &str, tags: &[String]) -> Result<Vec<String>> {
    let now = now_ts();
    let mut clean: Vec<String> = Vec::new();
    for raw in tags {
        let name = raw.trim();
        if name.is_empty() || name.chars().count() > 24 {
            continue;
        }
        if clean.iter().any(|t| t == name) {
            continue;
        }
        clean.push(name.to_string());
        // 单本书上限 20 个：再多就不是标签，是备注
        if clean.len() >= 20 {
            break;
        }
    }

    conn.execute("DELETE FROM book_tags WHERE book_id = ?1", params![book_id])?;
    for name in &clean {
        conn.execute(
            "INSERT OR IGNORE INTO tags (name, created_at) VALUES (?1, ?2)",
            params![name, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO book_tags (book_id, tag, added_at) VALUES (?1, ?2, ?3)",
            params![book_id, name, now],
        )?;
    }
    // 没有任何书引用的标签顺手清掉，侧栏不要留空壳
    conn.execute(
        "DELETE FROM tags WHERE name NOT IN (SELECT tag FROM book_tags)",
        [],
    )?;
    Ok(clean)
}

/// 删除一个标签，连带所有书的关联。
pub fn delete_tag(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("DELETE FROM tags WHERE name = ?1", params![name])?;
    Ok(())
}

fn row_to_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    let book_type: String = row.get("type")?;
    let format: String = row.get("format")?;
    let path: String = row.get("path")?;
    let cover_state: String = row.get("cover_state")?;
    let progress_json: Option<String> = row.get("progress_json")?;
    let metadata_json: Option<String> = row.get("metadata_json")?;
    // 老库补列前这里是 NULL，get 失败时按默认值走
    let status: Option<String> = row.get("status").ok();

    let progress = progress_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<Progress>(s).ok());
    let metadata = metadata_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    Ok(Book {
        id: row.get("id")?,
        book_type: BookType::parse(&book_type),
        format: BookFormat::parse(&format).unwrap_or(BookFormat::Txt),
        path: path.clone(),
        size: row.get("size")?,
        mtime: row.get("mtime")?,
        title: row.get("title")?,
        author: row.get("author")?,
        cover_path: row.get("cover_path")?,
        cover_state: CoverState::parse(&cover_state),
        meta_locked: row.get::<_, i64>("meta_locked").unwrap_or(0) != 0,
        status: BookStatus::parse(status.as_deref().unwrap_or("ok")),
        private: row.get::<_, i64>("private").unwrap_or(0) != 0,
        missing: !Path::new(&path).exists(),
        progress,
        metadata,
        added_at: row.get("added_at")?,
        last_read_at: row.get("last_read_at")?,
    })
}

/// 写入 / 更新一条书籍记录。
///
/// **不碰 `private` 列**：扫描器每次都会用 `new_book` 造一条 `private: false` 的记录，
/// 如果这里跟着写，重新扫描一次就会把隐私书搬回公开书架。标记只由 `set_private` 改。
pub fn upsert_book(conn: &Connection, book: &Book) -> Result<()> {
    let progress_json = match &book.progress {
        Some(p) => Some(serde_json::to_string(p)?),
        None => None,
    };
    let metadata_json = match &book.metadata {
        Some(m) => Some(serde_json::to_string(m)?),
        None => None,
    };

    conn.execute(
        r#"INSERT INTO books
             (id, type, format, path, size, mtime, title, author,
              cover_path, cover_state, progress_json, metadata_json, added_at, last_read_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
           ON CONFLICT(path) DO UPDATE SET
             size = excluded.size,
             mtime = excluded.mtime,
             title = excluded.title,
             author = excluded.author,
             cover_path = excluded.cover_path,
             cover_state = excluded.cover_state"#,
        params![
            book.id,
            book.book_type.as_str(),
            book.format.as_str(),
            book.path,
            book.size,
            book.mtime,
            book.title,
            book.author,
            book.cover_path,
            book.cover_state.as_str(),
            progress_json,
            metadata_json,
            book.added_at,
            book.last_read_at,
        ],
    )?;
    Ok(())
}

/// 返回 (id, size, mtime)。用于增量扫描判定。
pub fn existing_stamp(conn: &Connection, path: &str) -> Result<Option<(String, i64, i64)>> {
    let row = conn
        .query_row(
            "SELECT id, size, mtime FROM books WHERE path = ?1",
            params![path],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
        )
        .optional()?;
    Ok(row)
}

/// 公开书架。查 `books_visible` 而不是 `books`——默认安全，漏写条件也不会泄露。
pub fn list_books(
    conn: &Connection,
    query: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Book>> {
    list_from(conn, "books_visible", query, kind)
}

/// 隐私书架。只有会话解锁时调用方才会走到这里（命令层负责拦）。
pub fn list_private(conn: &Connection, query: Option<&str>) -> Result<Vec<Book>> {
    list_from(conn, "books_private", query, None)
}

fn list_from(
    conn: &Connection,
    table: &str,
    query: Option<&str>,
    kind: Option<&str>,
) -> Result<Vec<Book>> {
    let mut sql = format!("SELECT * FROM {table} WHERE 1=1");
    let mut args: Vec<String> = Vec::new();

    if let Some(k) = kind {
        if k != "all" {
            sql.push_str(" AND type = ?");
            args.push(k.to_string());
        }
    }
    if let Some(q) = query {
        let q = q.trim();
        if !q.is_empty() {
            sql.push_str(" AND (title LIKE ? OR COALESCE(author,'') LIKE ?)");
            let like = format!("%{q}%");
            args.push(like.clone());
            args.push(like);
        }
    }
    sql.push_str(" ORDER BY COALESCE(last_read_at,0) DESC, added_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), row_to_book)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_book(conn: &Connection, id: &str) -> Result<Option<Book>> {
    let book = conn
        .query_row("SELECT * FROM books WHERE id = ?1", params![id], row_to_book)
        .optional()?;
    Ok(book)
}

pub fn save_progress(conn: &Connection, id: &str, progress: &Progress) -> Result<()> {
    let json = serde_json::to_string(progress)?;
    conn.execute(
        "UPDATE books SET progress_json = ?1, last_read_at = ?2 WHERE id = ?3",
        params![json, now_ts(), id],
    )?;
    Ok(())
}

/// 内嵌元数据回写：MOBI 的书名与作者只有解析正文时才拿得到。
pub fn update_title_author(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    author: Option<&str>,
) -> Result<()> {
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        conn.execute("UPDATE books SET title = ?1 WHERE id = ?2", params![t, id])?;
    }
    if let Some(a) = author.map(str::trim).filter(|a| !a.is_empty()) {
        conn.execute("UPDATE books SET author = ?1 WHERE id = ?2", params![a, id])?;
    }
    Ok(())
}

/// 写入用户手动编辑的书名与作者，并置位 meta_locked。
/// 允许 author 为空（清空作者），title 由调用方保证非空。
pub fn set_meta(
    conn: &Connection,
    id: &str,
    title: &str,
    author: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET title = ?1, author = ?2, meta_locked = 1 WHERE id = ?3",
        params![title, author, id],
    )?;
    Ok(())
}

/// 修正书籍大类。用于「打开时才发现实际是图片型」这类后验判断。
pub fn update_book_type(
    conn: &Connection,
    id: &str,
    book_type: crate::models::BookType,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET type = ?1 WHERE id = ?2",
        params![book_type.as_str(), id],
    )?;
    Ok(())
}

/// 标记记录状态（目前只有「待恢复」会用到，UX §10.2）。
pub fn set_status(conn: &Connection, id: &str, status: BookStatus) -> Result<()> {
    conn.execute(
        "UPDATE books SET status = ?1 WHERE id = ?2",
        params![status.as_str(), id],
    )?;
    Ok(())
}

/// 「重新定位」：把记录指到新路径，并刷新随文件走的那些字段。
///
/// 不碰 progress / added_at / last_read_at —— 用户只是想修好路径，
/// 阅读进度和加入时间不该因此丢失。封面必须重置：旧封面是从旧文件里
/// 抽出来的，新文件未必是同一本。
pub fn relocate(
    conn: &Connection,
    id: &str,
    path: &str,
    size: i64,
    mtime: i64,
    title: Option<&str>,
    book_type: BookType,
    format: BookFormat,
) -> Result<()> {
    conn.execute(
        r#"UPDATE books SET
             path = ?1, size = ?2, mtime = ?3,
             title = COALESCE(?4, title),
             type = ?5, format = ?6,
             status = 'ok',
             cover_path = NULL, cover_state = 'pending'
           WHERE id = ?7"#,
        params![
            path,
            size,
            mtime,
            title,
            book_type.as_str(),
            format.as_str(),
            id
        ],
    )?;
    Ok(())
}

/// 删除一条书籍记录，并清掉「根就是这本书」的书库根，
/// 否则下次扫描会把它再加回来。
pub fn delete_book(conn: &Connection, id: &str) -> Result<()> {
    let path: Option<String> = conn
        .query_row("SELECT path FROM books WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .ok();

    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;

    if let Some(path) = path {
        conn.execute(
            "DELETE FROM library_roots WHERE path = ?1",
            params![path],
        )?;
    }
    Ok(())
}

pub fn add_root(conn: &Connection, path: &str) -> Result<LibraryRoot> {
    /*
     * 已经是某条根的子路径就不用再登记。
     * 拖入一个书库目录里的单本书时会命中这里——否则同一个文件被扫两遍，
     * 失败一次记两次，「失败 3 个」里有两个其实是同一个 OFD。
     */
    let new_path = std::path::Path::new(path);
    if let Some(root) = list_roots(conn)?
        .into_iter()
        .find(|r| new_path.starts_with(&r.path))
    {
        return Ok(root);
    }

    let added_at = now_ts();
    conn.execute(
        "INSERT INTO library_roots (path, added_at) VALUES (?1, ?2)
         ON CONFLICT(path) DO NOTHING",
        params![path, added_at],
    )?;
    let root = conn.query_row(
        "SELECT id, path, added_at FROM library_roots WHERE path = ?1",
        params![path],
        |r| {
            Ok(LibraryRoot {
                id: r.get(0)?,
                path: r.get(1)?,
                added_at: r.get(2)?,
            })
        },
    )?;
    Ok(root)
}

pub fn list_roots(conn: &Connection) -> Result<Vec<LibraryRoot>> {
    let mut stmt =
        conn.prepare("SELECT id, path, added_at FROM library_roots ORDER BY added_at ASC")?;
    let rows = stmt.query_map([], |r| {
        Ok(LibraryRoot {
            id: r.get(0)?,
            path: r.get(1)?,
            added_at: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn remove_root(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM library_roots WHERE id = ?1", params![id])?;
    Ok(())
}

/// 清理：给定 root 前缀下，磁盘已不存在的记录。
pub fn remove_missing_under(conn: &Connection, root: &str) -> Result<u32> {
    let mut stmt = conn.prepare("SELECT id, path FROM books WHERE path LIKE ?1")?;
    let prefix = format!("{root}%");
    let rows = stmt.query_map(params![prefix], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut to_delete: Vec<String> = Vec::new();
    for row in rows {
        let (id, path) = row?;
        if !Path::new(&path).exists() {
            to_delete.push(id);
        }
    }
    for id in &to_delete {
        conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    }
    Ok(to_delete.len() as u32)
}

/// 全部书籍 id，用于判断缓存目录是否还有归属
pub fn all_book_ids(conn: &Connection) -> Result<std::collections::HashSet<String>> {
    let mut stmt = conn.prepare("SELECT id FROM books")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = std::collections::HashSet::new();
    for row in rows {
        out.insert(row?);
    }
    Ok(out)
}

/// 标记 / 取消隐私书架。只改这一列，别的字段一律不动。
pub fn set_private(conn: &Connection, id: &str, private: bool) -> Result<()> {
    conn.execute(
        "UPDATE books SET private = ?1 WHERE id = ?2",
        params![if private { 1 } else { 0 }, id],
    )?;
    Ok(())
}

/// 改封面路径与状态。隐私书把封面挪到 `private_covers/` 之后要用它把记录指过去。
pub fn set_cover(
    conn: &Connection,
    id: &str,
    path: Option<&str>,
    state: crate::models::CoverState,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET cover_path = ?1, cover_state = ?2 WHERE id = ?3",
        params![path, state.as_str(), id],
    )?;
    Ok(())
}

/// 公开书架的书数——`library_stats` 只该报这个数，
/// 否则「库里 30 本、书架显示 27 本」就成了隐私书的侧信道。
pub fn count_visible(conn: &Connection) -> Result<i64> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM books_visible", [], |r| r.get(0))?;
    Ok(n)
}

/// 隐私书架里的书数。备份前拿它决定要不要问用户、扫描时拿它做跳过判断。
pub fn count_private(conn: &Connection) -> Result<i64> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM books WHERE private = 1", [], |r| r.get(0))?;
    Ok(n)
}

// ---------------- 标注 ----------------

fn row_to_annotation(row: &Row<'_>) -> rusqlite::Result<Annotation> {
    let locator: String = row.get("locator_json")?;
    // 老库可能还没有 anchor_json 这一列，取不到就当没有锚点
    let anchor: Option<Anchor> = row
        .get::<_, Option<String>>("anchor_json")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(Annotation {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        kind: AnnotationKind::parse(&row.get::<_, String>("kind")?),
        // 解析失败就退回「整篇开头」，总比整条记录读不出来强
        locator: serde_json::from_str(&locator)
            .unwrap_or(Progress::Text { offset: 0, chapter: 0, total: 0 }),
        label: row.get("label")?,
        excerpt: row.get("excerpt")?,
        anchor,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_annotation(conn: &Connection, item: &Annotation) -> Result<()> {
    conn.execute(
        "INSERT INTO annotations (id, book_id, kind, locator_json, label, excerpt, anchor_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            item.id,
            item.book_id,
            item.kind.as_str(),
            serde_json::to_string(&item.locator)?,
            item.label,
            item.excerpt,
            item.anchor.as_ref().map(serde_json::to_string).transpose()?,
            item.created_at,
            item.updated_at
        ],
    )?;
    Ok(())
}

/// 按书取标注，新加的在前。`kind` 为 None 时返回全部。
pub fn list_annotations(
    conn: &Connection,
    book_id: &str,
    kind: Option<AnnotationKind>,
) -> Result<Vec<Annotation>> {
    let mut sql = String::from("SELECT * FROM annotations WHERE book_id = ?1");
    if kind.is_some() {
        sql.push_str(" AND kind = ?2");
    }
    sql.push_str(" ORDER BY created_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let rows = match kind {
        Some(k) => stmt.query_map(params![book_id, k.as_str()], row_to_annotation)?,
        None => stmt.query_map(params![book_id], row_to_annotation)?,
    };
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn update_annotation_label(conn: &Connection, id: &str, label: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE annotations SET label = ?1, updated_at = ?2 WHERE id = ?3",
        params![label, now_ts(), id],
    )?;
    Ok(())
}

pub fn delete_annotation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn count_annotations(conn: &Connection, book_id: &str) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM annotations WHERE book_id = ?1",
        params![book_id],
        |r| r.get(0),
    )?;
    Ok(n)
}

pub fn count_books(conn: &Connection) -> Result<i64> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))?;
    Ok(n)
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod path_rewrite_tests {
    use super::*;
    use std::path::MAIN_SEPARATOR;

    /// 用系统分隔符拼路径：这些断言跑在 Windows 上，但也别写死反斜杠
    fn join(base: &str, rest: &str) -> String {
        format!("{base}{}{rest}", MAIN_SEPARATOR)
    }

    fn seed(conn: &Connection, id: &str, path: &str, cover: Option<&str>) {
        conn.execute(
            "INSERT INTO books (id, type, format, path, size, mtime, title, cover_path, added_at)
             VALUES (?1,'novel','txt',?2,1,0,?1,?3,1)",
            params![id, path, cover],
        )
        .unwrap();
    }

    fn read(conn: &Connection, id: &str) -> (String, Option<String>, String) {
        conn.query_row(
            "SELECT path, cover_path, status FROM books WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    fn dirs() -> (String, String) {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        (join(&root, "com.lumviox.cenro"), join(&root, "com.lumivox.cenro"))
    }

    #[test]
    fn rewrites_books_and_covers_inside_the_old_directory() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let (old, new) = dirs();

        seed(&conn, "a", &join(&old, "inbox/书.txt"), Some(&join(&old, "covers/a.jpg")));
        // 用户自己的书库目录不在旧目录里：不该被动到
        seed(&conn, "b", &join("/books", "b.txt"), None);

        let fixed = rewrite_path_prefix(&conn, &old, &new).unwrap();
        assert_eq!(fixed, 1);

        let (path, cover, status) = read(&conn, "a");
        assert_eq!(path, join(&new, "inbox/书.txt"));
        assert_eq!(cover, Some(join(&new, "covers/a.jpg")));
        assert_eq!(status, "ok");
        assert_eq!(read(&conn, "b").0, join("/books", "b.txt"));
    }

    #[test]
    fn matches_case_insensitively_like_windows() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let (old, new) = dirs();
        let shouty = old.to_uppercase();
        seed(&conn, "a", &join(&shouty, "inbox/a.txt"), None);

        let fixed = rewrite_path_prefix(&conn, &old, &new).unwrap();
        assert_eq!(fixed, 1);
        assert!(read(&conn, "a").0.starts_with(&new));
    }

    #[test]
    fn no_op_when_prefix_matches_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        seed(&conn, "a", &join("/books", "a.txt"), None);
        assert_eq!(rewrite_path_prefix(&conn, "/old", "/new").unwrap(), 0);
        assert_eq!(rewrite_path_prefix(&conn, "", "/new").unwrap(), 0);
        assert_eq!(rewrite_path_prefix(&conn, "/same", "/same").unwrap(), 0);
    }
}

#[cfg(test)]
mod tag_tests {
    use super::*;

    fn seed(conn: &Connection, id: &str, private: bool) -> String {
        let book = Book {
            id: id.into(),
            book_type: BookType::Novel,
            format: BookFormat::Txt,
            path: format!("/tmp/{id}.txt"),
            size: 1,
            mtime: 0,
            title: id.into(),
            author: None,
            cover_path: None,
            cover_state: CoverState::Pending,
            meta_locked: false,
            status: BookStatus::Ok,
            private,
            missing: false,
            progress: None,
            metadata: None,
            added_at: 1,
            last_read_at: None,
        };
        upsert_book(conn, &book).unwrap();
        // upsert_book 刻意不写 private（扫描不能重置隐私标记），测试里手动置位
        if private {
            conn.execute("UPDATE books SET private = 1 WHERE id = ?1", params![id])
                .unwrap();
        }
        id.to_string()
    }

    fn conn_with_books() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        seed(&conn, "b1", false);
        seed(&conn, "b2", false);
        seed(&conn, "p1", true);
        conn
    }

    #[test]
    fn tags_count_only_visible_books() {
        let conn = conn_with_books();
        set_book_tags(&conn, "b1", &["工作".into(), "待读".into()]).unwrap();
        set_book_tags(&conn, "b2", &["工作".into()]).unwrap();
        set_book_tags(&conn, "p1", &["私密".into()]).unwrap();

        let tags = list_tags(&conn).unwrap();
        let work = tags.iter().find(|t| t.name == "工作").unwrap();
        assert_eq!(work.count, 2);
        // 隐私书的标签连计数都不该露面
        assert!(!tags.iter().any(|t| t.name == "私密"));
    }

    #[test]
    fn assignments_skip_private_books() {
        let conn = conn_with_books();
        set_book_tags(&conn, "b1", &["工作".into()]).unwrap();
        set_book_tags(&conn, "p1", &["私密".into()]).unwrap();

        let rows = list_tag_assignments(&conn).unwrap();
        assert_eq!(rows, vec![("b1".to_string(), "工作".to_string())]);
    }

    #[test]
    fn set_replaces_and_cleans_dropped_tags() {
        let conn = conn_with_books();
        set_book_tags(&conn, "b1", &["工作".into(), "待读".into()]).unwrap();
        // 全量替换：只留一个，另一个不该继续挂在书上也该从标签表消失
        let saved = set_book_tags(&conn, "b1", &["待读".into()]).unwrap();
        assert_eq!(saved, vec!["待读".to_string()]);

        let names: Vec<String> = list_tags(&conn).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["待读".to_string()]);
    }

    #[test]
    fn trims_blanks_dedupes_and_caps() {
        let conn = conn_with_books();
        let mut input = vec!["  工作  ".into(), "工作".into(), "   ".into()];
        for i in 0..30 {
            input.push(format!("t{i}"));
        }
        let saved = set_book_tags(&conn, "b1", &input).unwrap();
        assert_eq!(saved[0], "工作");
        // 空串被丢掉、重复被合并、总量封顶 20
        assert_eq!(saved.len(), 20);
        assert_eq!(saved.iter().filter(|t| *t == "工作").count(), 1);
    }

    #[test]
    fn deleting_a_book_drops_its_tag_links() {
        let conn = conn_with_books();
        set_book_tags(&conn, "b1", &["工作".into()]).unwrap();
        conn.execute("DELETE FROM books WHERE id = 'b1'", []).unwrap();
        assert!(list_tag_assignments(&conn).unwrap().is_empty());
    }

    #[test]
    fn delete_tag_removes_links() {
        let conn = conn_with_books();
        set_book_tags(&conn, "b1", &["工作".into(), "待读".into()]).unwrap();
        delete_tag(&conn, "工作").unwrap();
        let names: Vec<String> = list_tags(&conn).unwrap().into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["待读".to_string()]);
    }
}

#[cfg(test)]
mod annotation_tests {
    use super::*;

    fn seed(conn: &Connection) -> String {
        let book = Book {
            id: "b1".into(),
            book_type: BookType::Novel,
            format: BookFormat::Txt,
            path: "/tmp/b1.txt".into(),
            size: 1,
            mtime: 0,
            title: "测试".into(),
            author: None,
            cover_path: None,
            cover_state: CoverState::Pending,
            meta_locked: false,
            status: BookStatus::Ok,
            private: false,
            missing: false,
            progress: None,
            metadata: None,
            added_at: 1,
            last_read_at: None,
        };
        upsert_book(conn, &book).unwrap();
        book.id
    }

    fn bookmark(book_id: &str, offset: u64) -> Annotation {
        Annotation {
            id: uuid_like(offset),
            book_id: book_id.to_string(),
            kind: AnnotationKind::Bookmark,
            locator: Progress::Text {
                offset,
                chapter: 0,
                total: 1000,
            },
            label: Some(format!("第 {offset} 字节")),
            excerpt: Some("片段".into()),
            anchor: None,
            created_at: offset as i64,
            updated_at: offset as i64,
        }
    }

    fn uuid_like(n: u64) -> String {
        format!("id-{n}")
    }

    #[test]
    fn inserts_lists_and_deletes() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let book_id = seed(&conn);

        insert_annotation(&conn, &bookmark(&book_id, 100)).unwrap();
        insert_annotation(&conn, &bookmark(&book_id, 200)).unwrap();

        // 新的在前
        let list = list_annotations(&conn, &book_id, None).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].created_at, 200);
        match &list[0].locator {
            Progress::Text { offset, .. } => assert_eq!(*offset, 200),
            other => panic!("定位类型不对：{other:?}"),
        }

        // 按 kind 过滤
        assert_eq!(
            list_annotations(&conn, &book_id, Some(AnnotationKind::Bookmark))
                .unwrap()
                .len(),
            2
        );
        assert!(list_annotations(&conn, &book_id, Some(AnnotationKind::Note))
            .unwrap()
            .is_empty());

        update_annotation_label(&conn, &list[0].id, Some("改过")).unwrap();
        let again = list_annotations(&conn, &book_id, None).unwrap();
        assert_eq!(again[0].label.as_deref(), Some("改过"));

        delete_annotation(&conn, &list[0].id).unwrap();
        assert_eq!(count_annotations(&conn, &book_id).unwrap(), 1);
    }

    /// 删书要连标注一起删（ON DELETE CASCADE），否则会留下一堆孤儿行
    #[test]
    fn deleting_a_book_drops_its_annotations() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let book_id = seed(&conn);
        insert_annotation(&conn, &bookmark(&book_id, 1)).unwrap();
        assert_eq!(count_annotations(&conn, &book_id).unwrap(), 1);

        delete_book(&conn, &book_id).unwrap();
        assert_eq!(count_annotations(&conn, &book_id).unwrap(), 0);
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// 旧版本库没有 meta_locked 列，升级后必须能正常读出来。
    /// 这条路径真实存在：用户的书库是上一版建的，`CREATE TABLE IF NOT EXISTS`
    /// 不会补列，只能靠 init 里的 ALTER。
    #[test]
    fn migrates_old_schema_without_meta_locked() {
        let conn = Connection::open_in_memory().unwrap();

        // 上一版的表结构（无 meta_locked）
        conn.execute_batch(
            r#"
            CREATE TABLE books (
              id            TEXT PRIMARY KEY,
              type          TEXT NOT NULL,
              format        TEXT NOT NULL,
              path          TEXT NOT NULL UNIQUE,
              size          INTEGER NOT NULL,
              mtime         INTEGER NOT NULL,
              title         TEXT NOT NULL,
              author        TEXT,
              cover_path    TEXT,
              cover_state   TEXT NOT NULL DEFAULT 'pending',
              progress_json TEXT,
              metadata_json TEXT,
              added_at      INTEGER NOT NULL,
              last_read_at  INTEGER
            );
            "#,
        )
        .unwrap();

        conn.execute(
            "INSERT INTO books (id, type, format, path, size, mtime, title, added_at)
             VALUES ('old', 'novel', 'txt', '/tmp/old.txt', 1, 0, '旧书名', 0)",
            [],
        )
        .unwrap();

        init(&conn).unwrap();

        let book = get_book(&conn, "old").unwrap().expect("旧记录应当可读");
        assert_eq!(book.title, "旧书名");
        assert!(!book.meta_locked, "旧库迁移后默认未锁定");
        assert_eq!(book.status, BookStatus::Ok, "旧库迁移后不能凭空变成待恢复");
    }

    /// 旧库的 `type` 上带着 `CHECK (type IN ('novel','comic','pdf'))`，
    /// 新增「文档」类型后写库会被约束拒绝（表现为「导入失败」且没有原因）。
    #[test]
    fn migrates_legacy_type_check_and_keeps_rows() {
        let conn = Connection::open_in_memory().unwrap();

        conn.execute_batch(
            r#"
            CREATE TABLE books (
              id            TEXT PRIMARY KEY,
              type          TEXT NOT NULL CHECK(type IN ('novel','comic','pdf')),
              format        TEXT NOT NULL,
              path          TEXT NOT NULL UNIQUE,
              size          INTEGER NOT NULL,
              mtime         INTEGER NOT NULL,
              title         TEXT NOT NULL,
              author        TEXT,
              cover_path    TEXT,
              cover_state   TEXT NOT NULL DEFAULT 'pending',
              meta_locked   INTEGER NOT NULL DEFAULT 0,
              status        TEXT NOT NULL DEFAULT 'ok',
              progress_json TEXT,
              metadata_json TEXT,
              added_at      INTEGER NOT NULL,
              last_read_at  INTEGER
            );
            CREATE INDEX idx_books_type ON books(type);
            "#,
        )
        .unwrap();

        conn.execute(
            "INSERT INTO books (id, type, format, path, size, mtime, title, added_at)
             VALUES ('old', 'comic', 'cbz', '/tmp/old.cbz', 1, 0, '旧漫画', 0)",
            [],
        )
        .unwrap();

        init(&conn).unwrap();

        // 旧数据仍在，索引也重建回来了
        let book = get_book(&conn, "old").unwrap().expect("旧记录应当可读");
        assert_eq!(book.title, "旧漫画");
        let indexes: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type='index' AND name IN
                   ('idx_books_type','idx_books_last_read','idx_books_mtime')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 3, "重建表后索引必须补回来");

        // 关键断言：迁移后能写入新类型
        conn.execute(
            "INSERT INTO books (id, type, format, path, size, mtime, title, added_at)
             VALUES ('doc', 'doc', 'ofd', '/tmp/a.ofd', 1, 0, '公文', 0)",
            [],
        )
        .expect("迁移后应能写入 type=doc");
    }

    /// 「重新定位」只改路径与随文件走的字段。
    /// 阅读进度和加入时间是用户攒下来的，不能因为修个路径就清掉。
    #[test]
    fn relocate_keeps_progress_and_timestamps() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        conn.execute(
            "INSERT INTO books (id, type, format, path, size, mtime, title, status,
                                progress_json, added_at, last_read_at)
             VALUES ('b','novel','txt','/tmp/a.txt',1,0,'旧名','pending',
                     '{\"kind\":\"text\",\"offset\":10,\"chapter\":1}',123,456)",
            [],
        )
        .unwrap();

        relocate(
            &conn,
            "b",
            "/tmp/b.txt",
            99,
            777,
            Some("新名"),
            BookType::Novel,
            BookFormat::Txt,
        )
        .unwrap();

        let book = get_book(&conn, "b").unwrap().unwrap();
        assert_eq!(book.path, "/tmp/b.txt");
        assert_eq!(book.size, 99);
        assert_eq!(book.mtime, 777);
        assert_eq!(book.title, "新名");
        assert_eq!(book.status, BookStatus::Ok, "重新定位后应解除待恢复");
        assert_eq!(book.added_at, 123);
        assert_eq!(book.last_read_at, Some(456));
        assert!(book.progress.is_some(), "阅读进度必须保留");
        assert!(book.cover_path.is_none(), "旧封面来自旧文件，必须重置");
        assert_eq!(book.cover_state, CoverState::Pending);
    }

    /// 书名被用户锁定过时，重新定位不该改标题（标题传 None）。
    #[test]
    fn relocate_without_title_keeps_existing_one() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();

        conn.execute(
            "INSERT INTO books (id, type, format, path, size, mtime, title, added_at)
             VALUES ('b','novel','txt','/tmp/a.txt',1,0,'定型书名',0)",
            [],
        )
        .unwrap();

        relocate(
            &conn,
            "b",
            "/tmp/b.txt",
            1,
            0,
            None,
            BookType::Novel,
            BookFormat::Txt,
        )
        .unwrap();

        let book = get_book(&conn, "b").unwrap().unwrap();
        assert_eq!(book.title, "定型书名");
    }
}
