//! Windows uses its installed SAPI dictation engines. Linux uses local whisper.cpp.
//! Audio and process output live in private temporary files and never go to a Host.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};

type Jobs = Arc<Mutex<HashMap<String, bool>>>;

#[derive(Clone, Default)]
pub struct SpeechJobs(Jobs);

impl SpeechJobs {
    pub fn shutdown(&self) {
        if let Ok(mut active) = self.0.lock() {
            for cancelled in active.values_mut() {
                *cancelled = true;
            }
        }
        // Let workers kill/reap children before the app exits.
        for _ in 0..40 {
            if self.0.lock().is_ok_and(|active| active.is_empty()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct SpeechResult {
    text: String,
    error: Option<String>,
}

fn validate_language(language: &str) -> Result<(), String> {
    if language.len() > 64
        || !language
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("语音识别语言无效".into());
    }
    Ok(())
}

fn decode_audio(data: &str) -> Result<Vec<u8>, String> {
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    if data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("录音超过 4 MiB，请缩短录音后重试".into());
    }
    let audio = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "录音数据无效")?;
    // Only accept the fixed PCM16/mono/16 kHz WAV produced by our recorder.
    // Checking the header also keeps compressed or malformed audio out of SAPI.
    if audio.len() <= 44
        || audio.len() > MAX_BYTES
        || &audio[..4] != b"RIFF"
        || &audio[8..16] != b"WAVEfmt "
        || audio[16..36]
            != [
                16, 0, 0, 0, 1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0,
            ]
        || &audio[36..40] != b"data"
        || audio.len() % 2 != 0
        || u32::from_le_bytes(audio[4..8].try_into().unwrap()) as usize != audio.len() - 8
        || u32::from_le_bytes(audio[40..44].try_into().unwrap()) as usize != audio.len() - 44
    {
        return Err("本机语音识别需要 16 kHz 单声道 PCM WAV 录音".into());
    }
    Ok(audio)
}

fn read_text(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| "无法读取本机识别结果")?;
    let mut bytes = Vec::new();
    file.take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取本机识别结果")?;
    if bytes.len() > 128 * 1024 {
        return Err("本机识别结果过大，请缩短录音后重试".into());
    }
    String::from_utf8(bytes)
        .map(|text| text.trim_start_matches('\u{feff}').trim().to_owned())
        .map_err(|_| "本机识别结果编码无效".into())
}

fn run_process(
    command: &mut Command,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    let stdout = tempfile::NamedTempFile::new().map_err(|_| "无法准备本机识别输出")?;
    // Redirect stderr too: a full pipe must never block recognition or cancellation.
    let stderr = tempfile::NamedTempFile::new().map_err(|_| "无法准备本机识别输出")?;
    command
        .stdin(Stdio::null())
        .stdout(stdout.reopen().map_err(|_| "无法准备本机识别输出")?)
        .stderr(stderr.reopen().map_err(|_| "无法准备本机识别输出")?);
    // External recognizers must load system libraries, including from AppImage.
    for (key, value) in crate::appimage_env::child_env() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if cancelled() {
        return Err("语音输入已取消".into());
    }
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动本机识别引擎，请检查安装及可执行文件路径")?;
    let started = Instant::now();
    let result = loop {
        if cancelled() {
            break Err("语音输入已取消".into());
        }
        if started.elapsed() >= timeout {
            break Err("本机语音识别超时，请缩短录音或使用较小的离线模型".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break read_text(stdout.path()),
            Ok(Some(_)) => break Err("本机语音识别失败，请检查引擎和语言模型是否可用".into()),
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(_) => break Err("无法读取本机识别进程状态".into()),
        }
    };
    // Always reap the process before deleting its private audio/output files.
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(target_os = "windows")]
fn recognize(
    language: &str,
    _executable: Option<&str>,
    _model: Option<&str>,
    audio: Option<&Path>,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let powershell = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script: Vec<u8> = include_str!("windows_speech.ps1")
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut command = Command::new(powershell);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &base64::engine::general_purpose::STANDARD.encode(script),
    ]);
    command.env("PIER_SPEECH_LANGUAGE", language);
    command.env("PIER_SPEECH_AUDIO", audio.unwrap_or_else(|| Path::new("")));
    let output = run_process(
        &mut command,
        Duration::from_secs(if audio.is_some() { 180 } else { 15 }),
        cancelled,
    )?;
    let result: SpeechResult =
        serde_json::from_str(&output).map_err(|_| "无法读取 Windows 语音识别结果")?;
    result.error.map_or(Ok(result.text), Err)
}

#[cfg(target_os = "linux")]
fn recognize(
    language: &str,
    executable: Option<&str>,
    model: Option<&str>,
    audio: Option<&Path>,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    let model = PathBuf::from(model.unwrap_or_default());
    if !model.is_file() {
        return Err("请在设置 → 常规 → 语音输入中选择 whisper.cpp 的本机模型文件".into());
    }
    let mut command = Command::new(
        executable
            .filter(|value| !value.is_empty())
            .unwrap_or("whisper-cli"),
    );
    let Some(audio) = audio else {
        command.arg("--help");
        return run_process(&mut command, Duration::from_secs(10), cancelled);
    };
    let output = tempfile::tempdir().map_err(|_| "无法准备本机识别输出")?;
    let prefix = output.path().join("transcript");
    let language = match language.split('-').next().unwrap_or_default() {
        "" => "auto",
        value => value,
    };
    command
        .arg("--model")
        .arg(model)
        .arg("--file")
        .arg(audio)
        .arg("--language")
        .arg(language)
        .arg("--no-timestamps")
        .arg("--no-prints")
        .arg("--output-txt")
        .arg("--output-file")
        .arg(&prefix);
    run_process(&mut command, Duration::from_secs(180), cancelled)?;
    read_text(&prefix.with_extension("txt"))
}

#[tauri::command]
pub async fn system_speech_authorize(
    language: String,
    executable: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    validate_language(&language)?;
    tauri::async_runtime::spawn_blocking(move || {
        recognize(
            &language,
            executable.as_deref(),
            model.as_deref(),
            None,
            || false,
        )
        .map(|_| ())
    })
    .await
    .map_err(|_| "无法准备本机语音识别")?
}

#[tauri::command]
pub fn system_speech_transcribe(
    jobs: State<'_, SpeechJobs>,
    id: String,
    data: String,
    language: String,
    executable: Option<String>,
    model: Option<String>,
    output: Channel<SpeechResult>,
) -> Result<(), String> {
    validate_language(&language)?;
    if id.is_empty() || id.len() > 128 {
        return Err("语音识别参数无效".into());
    }
    let audio = decode_audio(&data)?;
    let mut file = tempfile::Builder::new()
        .prefix("pier-speech-")
        .suffix(".wav")
        .tempfile()
        .map_err(|_| "无法准备本机识别录音")?;
    file.write_all(&audio).map_err(|_| "无法保存临时录音")?;
    // Close the writable handle before SAPI opens the WAV with FileShare.Read.
    // TempPath retains ownership and removes the recording after the worker ends.
    let file = file.into_temp_path();
    let jobs = jobs.0.clone();
    {
        let mut active = jobs.lock().map_err(|_| "无法准备本机语音识别")?;
        if !active.is_empty() {
            return Err("已有本机语音识别正在进行，请稍后重试".into());
        }
        active.insert(id.clone(), false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = recognize(
            &language,
            executable.as_deref(),
            model.as_deref(),
            Some(file.as_ref()),
            || {
                jobs.lock()
                    .map_or(true, |active| *active.get(&id).unwrap_or(&true))
            },
        );
        if let Ok(mut active) = jobs.lock() {
            active.remove(&id);
        }
        let message = match result {
            Ok(text) => SpeechResult { text, error: None },
            Err(error) => SpeechResult {
                text: String::new(),
                error: Some(error),
            },
        };
        let _ = output.send(message);
    });
    Ok(())
}

#[tauri::command]
pub fn system_speech_cancel(jobs: State<'_, SpeechJobs>, id: String) -> Result<(), String> {
    if let Some(cancelled) = jobs
        .0
        .lock()
        .map_err(|_| "无法取消本机语音识别")?
        .get_mut(&id)
    {
        *cancelled = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav() -> Vec<u8> {
        let mut bytes = b"RIFF\x26\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\x02\0\0\0\0\0".to_vec();
        bytes[44..].copy_from_slice(&[0, 0]);
        bytes
    }

    #[test]
    fn accepts_pcm_and_rejects_empty_compressed_or_truncated_audio() {
        let audio = wav();
        let base64 = base64::engine::general_purpose::STANDARD;
        assert_eq!(decode_audio(&base64.encode(&audio)).unwrap(), audio);
        for invalid in [&audio[..43], &audio[..45], b"not a WAV", b""] {
            assert!(decode_audio(&base64.encode(invalid)).is_err());
        }
        let mut invalid = audio.clone();
        invalid[20] = 3; // IEEE float, not PCM16.
        assert!(decode_audio(&base64.encode(invalid)).is_err());
        assert!(decode_audio("!").is_err());
    }

    #[test]
    fn validates_language_and_limits_result_size() {
        for language in ["", "zh-CN", "en-US", "yue-HK"] {
            assert!(validate_language(language).is_ok());
        }
        assert!(validate_language("zh\0CN").is_err());
        assert!(validate_language(&"z".repeat(65)).is_err());
        let mut output = tempfile::NamedTempFile::new().unwrap();
        output.write_all(&vec![b'x'; 128 * 1024 + 1]).unwrap();
        assert!(read_text(output.path()).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn invokes_whisper_with_unicode_paths_as_arguments_and_normalizes_language() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("whisper 引擎's cli");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
if [ "$1" = '--help' ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
    case "$1" in
        --model|--file) test -f "$2" || exit 2; shift ;;
        --language) language="$2"; shift ;;
        --output-file) output="$2"; shift ;;
    esac
    shift
done
printf ' %s 离线识别 \n' "$language" > "${output}.txt"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let model = directory.path().join("中文 模型.bin");
        std::fs::write(&model, []).unwrap();
        let audio = directory.path().join("语音.wav");
        std::fs::write(&audio, wav()).unwrap();
        let executable = executable.to_str();
        let model = model.to_str();
        assert!(recognize("", executable, model, None, || false).is_ok());
        assert_eq!(
            recognize("zh-CN", executable, model, Some(&audio), || false).unwrap(),
            "zh 离线识别"
        );
        assert_eq!(
            recognize("", executable, model, Some(&audio), || false).unwrap(),
            "auto 离线识别"
        );
        assert!(recognize("", executable, None, None, || false)
            .unwrap_err()
            .contains("模型文件"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cancels_and_times_out_processes_without_waiting_for_recognition() {
        let started = Instant::now();
        let error = run_process(
            Command::new("sleep").arg("10"),
            Duration::from_secs(5),
            || started.elapsed() > Duration::from_millis(40),
        )
        .unwrap_err();
        assert!(error.contains("取消"));
        assert!(started.elapsed() < Duration::from_secs(2));
        let started = Instant::now();
        let error = run_process(
            Command::new("sleep").arg("10"),
            Duration::from_millis(40),
            || false,
        )
        .unwrap_err();
        assert!(error.contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_engine_probe_returns_an_actionable_result_without_audio() {
        // CI images need not have a speech language installed. Either result
        // still exercises PowerShell parsing, Unicode output and JSON decoding.
        match recognize("", None, None, None, || false) {
            Err(error) => assert!(error.contains("Windows"), "{error}"),
            Ok(_) => {
                let mut audio = wav();
                audio.resize(32_044, 0);
                audio[4..8].copy_from_slice(&32_036_u32.to_le_bytes());
                audio[40..44].copy_from_slice(&32_000_u32.to_le_bytes());
                let mut file = tempfile::NamedTempFile::new().unwrap();
                file.write_all(&audio).unwrap();
                let path = file.into_temp_path();
                assert!(recognize("", None, None, Some(path.as_ref()), || false)
                    .unwrap()
                    .is_empty());
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires PIER_TEST_WHISPER, PIER_TEST_MODEL and PIER_TEST_AUDIO"]
    fn transcribes_real_audio_with_whisper() {
        let executable = std::env::var("PIER_TEST_WHISPER").unwrap();
        let model = std::env::var("PIER_TEST_MODEL").unwrap();
        let audio = PathBuf::from(std::env::var_os("PIER_TEST_AUDIO").unwrap());
        let text = recognize(
            "en-US",
            Some(&executable),
            Some(&model),
            Some(&audio),
            || false,
        )
        .unwrap();
        assert!(
            text.to_lowercase().contains("ask not what your country"),
            "{text}"
        );
    }
}
