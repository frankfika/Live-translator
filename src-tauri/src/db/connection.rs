use rusqlite::{Connection, Result};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn new() -> Result<Self> {
        let db_path = Self::get_db_path()?;

        // 确保目录存在
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        let conn = Connection::open(&db_path)?;

        // 启用 WAL + 外键 + busy timeout
        // WAL 让读不阻塞写，写不阻塞读
        // foreign_keys 默认是 OFF，必须每个连接显式打开
        // busy_timeout 5s，让短时的 SQLITE_BUSY 自动重试而不是报错给用户
        if let Err(e) = conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        ) {
            eprintln!("WARN: failed to set pragmas (continuing with defaults): {e}");
        }

        // 初始化数据库 schema
        crate::db::schema::init_database(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn get_db_path() -> Result<PathBuf> {
        let home_dir = dirs::home_dir()
            .ok_or_else(|| rusqlite::Error::InvalidPath("无法获取用户主目录".into()))?;

        let db_dir = home_dir.join(".ai-interpreter");
        Ok(db_dir.join("data.db"))
    }

    pub fn get_connection(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }
}
