//! 原生系统音频（回环）采集。
//!
//! WebView 里拿系统声音一直是硬伤：macOS WKWebView 没有 getDisplayMedia，
//! Windows WebView2 的屏幕共享弹窗体验差且经常拿不到音轨。这里直接用 cpal：
//! - Windows：在默认输出设备上建输入流 = WASAPI loopback
//! - macOS 14.6+：cpal 会自动创建 Core Audio process tap 聚合设备
//! - Linux：ALSA 的 default 设备双向可用，用 cpal 建输入流会录到麦克风而不是回环；
//!   改为调用 parec / pw-record 录默认输出的 monitor（见 run_capture 的 Linux 实现）。
//!
//! 采到的音频在 Rust 侧混成单声道、降采样到 16kHz，每 50ms 通过 IPC Channel
//! 以原始 f32 LE 字节推给前端，前端直接喂给 VAD。

#![cfg_attr(not(any(target_os = "windows", target_os = "macos", target_os = "linux")), allow(dead_code))]

use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

pub const TARGET_RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = 800; // 50ms @ 16k

#[derive(Default)]
pub struct SystemAudioState {
    stop_tx: Mutex<Option<mpsc::Sender<()>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioInfo {
    pub sample_rate: u32,
    pub device: String,
}

/// 一阶低通 + 线性插值的轻量降采样器，对语音识别足够。
#[cfg_attr(target_os = "linux", allow(dead_code))]
struct Downsampler {
    step: f64,
    pos: f64,
    last: f32,
    lp: f32,
    alpha: f32,
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
impl Downsampler {
    fn new(src_rate: u32) -> Self {
        let cutoff = 7_000f32.min(src_rate as f32 * 0.45);
        let alpha = 1.0 - (-2.0 * std::f32::consts::PI * cutoff / src_rate as f32).exp();
        Self {
            step: src_rate as f64 / TARGET_RATE as f64,
            pos: 0.0,
            last: 0.0,
            lp: 0.0,
            alpha: if src_rate <= TARGET_RATE { 1.0 } else { alpha },
        }
    }

    fn process(&mut self, x: f32, out: &mut Vec<f32>) {
        self.lp += self.alpha * (x - self.lp);
        while self.pos <= 1.0 {
            out.push(self.last + (self.lp - self.last) * self.pos as f32);
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.last = self.lp;
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run_capture(
    channel: Channel<InvokeResponseBody>,
    ready: mpsc::Sender<Result<SystemAudioInfo, String>>,
    stop_rx: mpsc::Receiver<()>,
) {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample};

    fn build<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: SizedSample + Send + 'static,
        f32: FromSample<T>,
    {
        let channels = config.channels.max(1) as usize;
        let mut ds = Downsampler::new(config.sample_rate);
        let mut out: Vec<f32> = Vec::with_capacity(CHUNK_SAMPLES * 2);
        device.build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                for frame in data.chunks(channels) {
                    let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                    ds.process(sum / frame.len() as f32, &mut out);
                }
                while out.len() >= CHUNK_SAMPLES {
                    let bytes: Vec<u8> = out
                        .drain(..CHUNK_SAMPLES)
                        .flat_map(|s| s.to_le_bytes())
                        .collect();
                    let _ = channel.send(InvokeResponseBody::Raw(bytes));
                }
            },
            |err| eprintln!("[system-audio] stream error: {err}"),
            None,
        )
    }

    let result = (|| -> Result<(cpal::Stream, SystemAudioInfo), String> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "没有找到默认输出设备".to_string())?;
        #[allow(deprecated)]
        let name = device.name().unwrap_or_else(|_| "系统输出".into());
        let supported = device
            .default_output_config()
            .map_err(|e| format!("读取输出设备格式失败: {e}"))?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, &config, channel),
            SampleFormat::I16 => build::<i16>(&device, &config, channel),
            SampleFormat::U16 => build::<u16>(&device, &config, channel),
            SampleFormat::I32 => build::<i32>(&device, &config, channel),
            other => return Err(format!("不支持的采样格式 {other:?}")),
        }
        .map_err(|e| format!("创建系统音频采集失败: {e}"))?;
        stream.play().map_err(|e| format!("启动系统音频采集失败: {e}"))?;
        Ok((
            stream,
            SystemAudioInfo {
                sample_rate: TARGET_RATE,
                device: name,
            },
        ))
    })();

    match result {
        Ok((stream, info)) => {
            let _ = ready.send(Ok(info));
            // 阻塞到 stop；stream 在这个线程里 drop（部分后端的 Stream 不是 Send）
            let _ = stop_rx.recv();
            drop(stream);
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
}

/// Linux：WebKitGTK（GStreamer）不会把 PulseAudio 的 Monitor 设备暴露给网页，
/// getUserMedia 拿不到"电脑声音"。这里直接调用系统自带的录音工具录默认输出的 monitor：
/// PulseAudio 的 `parec`，或 PipeWire 的 `pw-record`。输出 16k 单声道 f32，不需要额外编译依赖。
#[cfg(target_os = "linux")]
fn linux_recorder() -> Option<(&'static str, Vec<&'static str>)> {
    let candidates: [(&str, Vec<&str>); 2] = [
        (
            "parec",
            vec![
                "--device=@DEFAULT_MONITOR@",
                "--format=float32le",
                "--rate=16000",
                "--channels=1",
                "--latency-msec=50",
                "--client-name=ai-interpreter",
            ],
        ),
        (
            "pw-record",
            vec![
                "-P",
                "{ stream.capture.sink=true }",
                "--format=f32",
                "--rate=16000",
                "--channels=1",
                "-",
            ],
        ),
    ];
    candidates.into_iter().find(|(bin, _)| which(bin))
}

#[cfg(target_os = "linux")]
fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file()))
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn run_capture(
    channel: Channel<InvokeResponseBody>,
    ready: mpsc::Sender<Result<SystemAudioInfo, String>>,
    stop_rx: mpsc::Receiver<()>,
) {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let Some((bin, args)) = linux_recorder() else {
        let _ = ready.send(Err("没有找到 parec 或 pw-record（请安装 pulseaudio-utils 或 pipewire）".into()));
        return;
    };
    let mut child = match Command::new(bin)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(format!("启动 {bin} 失败: {e}")));
            return;
        }
    };
    let mut stdout = child.stdout.take().expect("piped stdout");

    // 先读到第一块数据再报告成功：录音工具连不上音频服务时会立刻退出
    let mut buf = vec![0u8; CHUNK_SAMPLES * 4];
    let first = stdout.read_exact(&mut buf);
    if first.is_err() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        let _ = child.kill();
        let _ = child.wait();
        let msg = err.lines().next().unwrap_or("没有输出").to_string();
        let _ = ready.send(Err(format!("{bin} 无法录制电脑声音：{msg}")));
        return;
    }
    let _ = ready.send(Ok(SystemAudioInfo {
        sample_rate: TARGET_RATE,
        device: if bin == "parec" { "PulseAudio Monitor".into() } else { "PipeWire Monitor".into() },
    }));
    let _ = channel.send(InvokeResponseBody::Raw(buf.clone()));

    // 读线程：持续推数据；主循环等 stop 信号后杀掉子进程，读线程随 EOF 退出
    let reader = thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK_SAMPLES * 4];
        while stdout.read_exact(&mut buf).is_ok() {
            if channel.send(InvokeResponseBody::Raw(buf.clone())).is_err() {
                break;
            }
        }
    });
    let _ = stop_rx.recv();
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn run_capture(
    _channel: Channel<InvokeResponseBody>,
    ready: mpsc::Sender<Result<SystemAudioInfo, String>>,
    _stop_rx: mpsc::Receiver<()>,
) {
    let _ = ready.send(Err("unsupported".into()));
}

/// macOS 的进程音频 tap（CATapDescription）是 14.2 引入的，cpal 要求 14.6+；
/// 老系统上直接调用会因为找不到 ObjC 类而 panic，所以先查版本。
#[cfg(target_os = "macos")]
fn macos_version() -> Option<(u32, u32)> {
    let out = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_version(s: &str) -> Option<(u32, u32)> {
    let mut it = s.trim().split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

pub fn native_loopback_supported() -> bool {
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(target_os = "macos")]
    {
        macos_version().is_some_and(|v| v >= (14, 6))
    }
    #[cfg(target_os = "linux")]
    {
        linux_recorder().is_some()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[tauri::command]
pub fn system_audio_supported() -> bool {
    native_loopback_supported()
}

#[tauri::command]
pub fn start_system_audio(
    state: State<'_, SystemAudioState>,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<SystemAudioInfo, String> {
    if !native_loopback_supported() {
        return Err("当前系统不支持原生录制电脑声音".into());
    }
    stop_inner(&state);
    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::Builder::new()
        .name("system-audio".into())
        .spawn(move || run_capture(on_audio, ready_tx, stop_rx))
        .map_err(|e| e.to_string())?;
    let info = ready_rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => "系统音频采集启动超时".to_string(),
            mpsc::RecvTimeoutError::Disconnected => "系统音频采集线程异常退出".to_string(),
        })??;
    *state.stop_tx.lock().map_err(|e| e.to_string())? = Some(stop_tx);
    Ok(info)
}

#[tauri::command]
pub fn stop_system_audio(state: State<'_, SystemAudioState>) {
    stop_inner(&state);
}

fn stop_inner(state: &SystemAudioState) {
    if let Ok(mut guard) = state.stop_tx.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_os_versions() {
        assert_eq!(parse_version("14.6.1\n"), Some((14, 6)));
        assert_eq!(parse_version("15"), Some((15, 0)));
        assert_eq!(parse_version(""), None);
        assert!((14, 5) < (14, 6) && (15, 0) >= (14, 6));
    }

    #[test]
    fn downsampler_48k_to_16k_ratio() {
        let mut ds = Downsampler::new(48_000);
        let mut out = Vec::new();
        for i in 0..48_000 {
            ds.process((i as f32 * 0.01).sin(), &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 2, "got {}", out.len());
    }

    #[test]
    fn downsampler_44k1_ratio() {
        let mut ds = Downsampler::new(44_100);
        let mut out = Vec::new();
        for _ in 0..44_100 {
            ds.process(0.5, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 2, "got {}", out.len());
        assert!((out.last().unwrap() - 0.5).abs() < 0.01);
    }
}
