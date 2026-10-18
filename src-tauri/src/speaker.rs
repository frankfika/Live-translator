//! 把"我说的话"的译文语音播到指定输出设备 —— 通常是虚拟声卡，会议软件把它当麦克风，
//! 对方就能听到译文：
//! - Windows：VB-Cable 的 "CABLE Input"（会议软件麦克风选 "CABLE Output"）
//! - macOS：BlackHole 2ch（会议软件麦克风选 "BlackHole 2ch"）
//! - Linux：自动用 PulseAudio / PipeWire 建一个 null sink + 虚拟麦克风，不用装任何东西
//!
//! 播放在单独线程里排队顺序进行，避免两句话叠在一起。

#![cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]

use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::State;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    /// 传回 play_audio 的设备标识（Windows/macOS 为设备名，Linux 为 sink 名）
    pub id: String,
    pub label: String,
    /// 看起来是虚拟声卡（适合把声音送进会议软件）
    pub is_virtual: bool,
}

struct Job {
    device: String,
    sample_rate: u32,
    samples: Vec<f32>,
}

pub struct SpeakerState {
    tx: Mutex<Option<mpsc::Sender<Job>>>,
}

impl Default for SpeakerState {
    fn default() -> Self {
        Self { tx: Mutex::new(None) }
    }
}

pub const LINUX_SINK: &str = "ai_interpreter_tts";
const LINUX_SOURCE: &str = "ai_interpreter_mic";

pub fn looks_virtual(name: &str) -> bool {
    let l = name.to_lowercase();
    [
        "cable input",
        "vb-audio",
        "voicemeeter",
        "blackhole",
        "loopback",
        "soundflower",
        "virtual",
        "虚拟",
        LINUX_SINK,
    ]
    .iter()
    .any(|k| l.contains(k))
}

// ── 设备列表 ─────────────────────────────────────────────────────────

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn list_devices() -> Result<Vec<OutputDevice>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for d in devices {
        #[allow(deprecated)]
        if let Ok(name) = d.name() {
            out.push(OutputDevice {
                is_virtual: looks_virtual(&name),
                label: name.clone(),
                id: name,
            });
        }
    }
    Ok(out)
}

#[cfg(target_os = "linux")]
fn list_devices() -> Result<Vec<OutputDevice>, String> {
    let out = std::process::Command::new("pactl")
        .args(["list", "sinks"])
        .output()
        .map_err(|e| format!("pactl 不可用: {e}"))?;
    Ok(parse_pactl_sinks(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn list_devices() -> Result<Vec<OutputDevice>, String> {
    Ok(vec![])
}

/// 解析 `pactl list sinks` 的 Name / Description
fn parse_pactl_sinks(text: &str) -> Vec<OutputDevice> {
    let mut out = Vec::new();
    let mut name: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("Name:") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = t.strip_prefix("Description:") {
            if let Some(n) = name.take() {
                let label = v.trim().to_string();
                out.push(OutputDevice {
                    is_virtual: looks_virtual(&n) || looks_virtual(&label),
                    id: n,
                    label,
                });
            }
        }
    }
    out
}

#[tauri::command]
pub fn list_output_devices() -> Result<Vec<OutputDevice>, String> {
    list_devices()
}

// ── Linux 虚拟麦克风 ─────────────────────────────────────────────────

/// 创建（或复用）"AI同传虚拟麦克风"：一个 null sink 用来播放译文，
/// 再把它的 monitor 重映射成一个普通的输入设备，会议软件里就能选它当麦克风。
/// 返回应当播放到的 sink 名。
#[tauri::command]
pub fn setup_virtual_mic() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let sinks = Command::new("pactl")
            .args(["list", "short", "sinks"])
            .output()
            .map_err(|e| format!("pactl 不可用（需要 PulseAudio 或 PipeWire）: {e}"))?;
        if !String::from_utf8_lossy(&sinks.stdout).contains(LINUX_SINK) {
            let ok = Command::new("pactl")
                .args([
                    "load-module",
                    "module-null-sink",
                    &format!("sink_name={LINUX_SINK}"),
                    "sink_properties=device.description=AI-Interpreter-Voice-Out",
                ])
                .stdout(std::process::Stdio::null())
                .status()
                .map_err(|e| e.to_string())?;
            if !ok.success() {
                return Err("创建虚拟输出设备失败".into());
            }
        }
        let sources = Command::new("pactl")
            .args(["list", "short", "sources"])
            .output()
            .map_err(|e| e.to_string())?;
        if !String::from_utf8_lossy(&sources.stdout).contains(LINUX_SOURCE) {
            let _ = Command::new("pactl")
                .args([
                    "load-module",
                    "module-remap-source",
                    &format!("master={LINUX_SINK}.monitor"),
                    &format!("source_name={LINUX_SOURCE}"),
                    "source_properties=device.description=AI-Interpreter-Virtual-Mic",
                ])
                .stdout(std::process::Stdio::null())
                .status();
        }
        Ok(LINUX_SINK.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("仅 Linux 支持自动创建虚拟麦克风".into())
    }
}

// ── 播放 ─────────────────────────────────────────────────────────────

fn player_loop(rx: mpsc::Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        if let Err(e) = play_blocking(&job) {
            eprintln!("[speaker] play failed: {e}");
        }
    }
}

#[cfg(target_os = "linux")]
fn play_blocking(job: &Job) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut args = vec![
        "--playback".to_string(),
        "--raw".to_string(),
        "--format=float32le".to_string(),
        format!("--rate={}", job.sample_rate),
        "--channels=1".to_string(),
        "--client-name=ai-interpreter-voice".to_string(),
    ];
    if !job.device.is_empty() {
        args.push(format!("--device={}", job.device));
    }
    let mut child = Command::new("pacat")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("pacat 不可用: {e}"))?;
    let bytes: Vec<u8> = job.samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn play_blocking(job: &Job) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};
    use std::collections::VecDeque;
    use std::sync::Arc;

    let host = cpal::default_host();
    let device = if job.device.is_empty() {
        host.default_output_device()
    } else {
        host.output_devices().ok().and_then(|mut ds| {
            #[allow(deprecated)]
            ds.find(|d| d.name().map(|n| n == job.device).unwrap_or(false))
        })
    }
    .ok_or_else(|| format!("找不到输出设备: {}", job.device))?;

    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let out_rate = config.sample_rate;
    let channels = config.channels.max(1) as usize;

    // 线性插值重采样到设备采样率
    let ratio = job.sample_rate as f64 / out_rate as f64;
    let n_out = ((job.samples.len() as f64) / ratio) as usize;
    let mut resampled = VecDeque::with_capacity(n_out);
    for i in 0..n_out {
        let pos = i as f64 * ratio;
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(job.samples.len().saturating_sub(1));
        let frac = (pos - i0 as f64) as f32;
        let a = job.samples.get(i0).copied().unwrap_or(0.0);
        let b = job.samples.get(i1).copied().unwrap_or(0.0);
        resampled.push_back(a + (b - a) * frac);
    }
    let queue = Arc::new(Mutex::new(resampled));

    fn build<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        channels: usize,
        queue: Arc<Mutex<VecDeque<f32>>>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: SizedSample + FromSample<f32> + Send + 'static,
    {
        device.build_output_stream(
            config,
            move |out: &mut [T], _| {
                let mut q = queue.lock().unwrap();
                for frame in out.chunks_mut(channels) {
                    let v = q.pop_front().unwrap_or(0.0);
                    for s in frame.iter_mut() {
                        *s = T::from_sample(v);
                    }
                }
            },
            |e| eprintln!("[speaker] stream error: {e}"),
            None,
        )
    }

    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, channels, queue.clone()),
        SampleFormat::I16 => build::<i16>(&device, &config, channels, queue.clone()),
        SampleFormat::U16 => build::<u16>(&device, &config, channels, queue.clone()),
        SampleFormat::I32 => build::<i32>(&device, &config, channels, queue.clone()),
        other => return Err(format!("不支持的输出格式 {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    loop {
        thread::sleep(std::time::Duration::from_millis(30));
        if queue.lock().map(|q| q.is_empty()).unwrap_or(true) {
            break;
        }
    }
    // 留一点尾巴，避免最后一个缓冲区被截掉
    thread::sleep(std::time::Duration::from_millis(150));
    drop(stream);
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn play_blocking(_job: &Job) -> Result<(), String> {
    Err("unsupported".into())
}

/// 播放一段单声道 PCM（16 位小端，base64）。
/// 用 base64 而不是原始字节：Linux 上 Tauri IPC 会把二进制 JSON 化，原始字节收不到。
/// 立即返回，播放在后台线程排队。
#[tauri::command]
pub fn play_audio(
    device: String,
    sample_rate: u32,
    pcm_b64: String,
    state: State<'_, SpeakerState>,
) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64.as_bytes())
        .map_err(|e| format!("音频数据损坏: {e}"))?;
    let samples: Vec<f32> = bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    let mut guard = state.tx.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("speaker".into())
            .spawn(move || player_loop(rx))
            .map_err(|e| e.to_string())?;
        *guard = Some(tx);
    }
    guard
        .as_ref()
        .unwrap()
        .send(Job {
            device,
            sample_rate,
            samples,
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pactl_sinks() {
        let text = "Sink #1\n\tState: IDLE\n\tName: ai_interpreter_tts\n\tDescription: AI-Interpreter-Voice-Out\nSink #2\n\tName: alsa_output.pci\n\tDescription: Built-in Audio\n";
        let d = parse_pactl_sinks(text);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].id, "ai_interpreter_tts");
        assert!(d[0].is_virtual);
        assert!(!d[1].is_virtual);
    }

    #[test]
    fn detects_virtual_devices() {
        assert!(looks_virtual("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(looks_virtual("BlackHole 2ch"));
        assert!(!looks_virtual("MacBook Pro Speakers"));
    }
}
