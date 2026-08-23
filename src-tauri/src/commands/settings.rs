use crate::db::Database;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_setting(key: String, db: State<'_, Arc<Database>>) -> Result<Option<String>, String> {
    let conn = db.get_connection();
    let conn = conn.lock().map_err(|e| e.to_string())?;

    let result: Result<String, rusqlite::Error> = conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    );

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn set_setting(key: String, value: String, db: State<'_, Arc<Database>>) -> Result<(), String> {
    let conn = db.get_connection();
    let conn = conn.lock().map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![key, value, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_all_settings(db: State<'_, Arc<Database>>) -> Result<Vec<(String, String)>, String> {
    let conn = db.get_connection();
    let conn = conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;

    let settings = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(settings)
}
