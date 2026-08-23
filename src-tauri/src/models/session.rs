use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub lang_a: String,
    pub lang_b: String,
    pub audio_source: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub message_count: i32,
}
