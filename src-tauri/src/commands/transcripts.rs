use crate::db::Database;
use crate::models::transcript::Transcript;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn save_transcript(
    session_id: String,
    original: String,
    translated: String,
    source_lang: String,
    target_lang: String,
    db: State<'_, Arc<Database>>,
) -> Result<i64, String> {
    let conn = db.get_connection();
    let conn = conn.lock().map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().timestamp();

    conn.execute(
        "INSERT INTO transcripts (session_id, original_text, translated_text, source_lang, target_lang, timestamp, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![session_id, original, translated, source_lang, target_lang, now, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub async fn get_session_transcripts(
    session_id: String,
    db: State<'_, Arc<Database>>,
) -> Result<Vec<Transcript>, String> {
    let conn = db.get_connection();
    let conn = conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, original_text, translated_text, source_lang, target_lang, timestamp, created_at
             FROM transcripts
             WHERE session_id = ?1
             ORDER BY timestamp ASC",
        )
        .map_err(|e| e.to_string())?;

    let transcripts = stmt
        .query_map(params![session_id], |row| {
            Ok(Transcript {
                id: Some(row.get(0)?),
                session_id: row.get(1)?,
                original_text: row.get(2)?,
                translated_text: row.get(3)?,
                source_lang: row.get(4)?,
                target_lang: row.get(5)?,
                timestamp: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(transcripts)
}

#[tauri::command]
pub async fn export_session(
    session_id: String,
    db: State<'_, Arc<Database>>,
) -> Result<String, String> {
    let transcripts = get_session_transcripts(session_id.clone(), db).await?;

    let mut content = String::from("AI 同声传译记录\n");
    content.push_str(&format!("会话 ID: {}\n", session_id));
    content.push_str(&format!("导出时间: {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")));
    content.push_str(&"=".repeat(50));
    content.push_str("\n\n");

    for transcript in transcripts {
        let time = chrono::DateTime::from_timestamp(transcript.timestamp, 0)
            .map(|dt| dt.format("%H:%M:%S").to_string())
            .unwrap_or_else(|| "未知时间".to_string());

        content.push_str(&format!("[{}]\n", time));
        if !transcript.original_text.is_empty() {
            content.push_str(&format!("原文: {}\n", transcript.original_text));
        }
        if !transcript.translated_text.is_empty() {
            content.push_str(&format!("译文: {}\n", transcript.translated_text));
        }
        content.push_str("\n");
    }

    Ok(content)
}
