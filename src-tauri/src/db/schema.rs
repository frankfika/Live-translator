use rusqlite::{Connection, Result};

pub fn init_database(conn: &Connection) -> Result<()> {
    // Defense in depth：connection.rs 已经设过，再设一次保证 init 路径独立可用
    conn.execute_batch("PRAGMA foreign_keys = ON")?;

    // 设置表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // 会话表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            lang_a TEXT NOT NULL,
            lang_b TEXT NOT NULL,
            audio_source TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            message_count INTEGER DEFAULT 0
        )",
        [],
    )?;

    // 转录记录表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS transcripts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            original_text TEXT NOT NULL,
            translated_text TEXT NOT NULL,
            source_lang TEXT NOT NULL,
            target_lang TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        )",
        [],
    )?;

    // 创建索引
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_transcripts_timestamp ON transcripts(timestamp)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC)",
        [],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_database() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(init_database(&conn).is_ok());

        // 验证表是否创建
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"transcripts".to_string()));
    }

    #[test]
    fn test_settings_table_structure() {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn).unwrap();

        // 测试插��设置
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            ["test_key", "test_value", "1234567890"],
        )
        .unwrap();

        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", ["test_key"], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(value, "test_value");
    }

    #[test]
    fn test_transcripts_foreign_key() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        init_database(&conn).unwrap();

        // 创建会话
        conn.execute(
            "INSERT INTO sessions (id, lang_a, lang_b, audio_source, started_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            ["session1", "English", "Chinese", "microphone", "1234567890"],
        )
        .unwrap();

        // 插入转录记录
        let result = conn.execute(
            "INSERT INTO transcripts (session_id, original_text, translated_text, source_lang, target_lang, timestamp, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            ["session1", "Hello", "你好", "English", "Chinese", "1234567890", "1234567890"],
        );

        assert!(result.is_ok());
    }
}
