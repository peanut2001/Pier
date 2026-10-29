//! Apple Speech runs in the desktop app, with its own system permission and no Host/API key.
use std::ffi::{c_char, c_void, CStr, CString};
use std::io::Write;

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tempfile::NamedTempFile;
use tokio::sync::oneshot;

type Callback = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char);
extern "C" {
    fn pier_speech_authorize(context: *mut c_void, callback: Callback);
    fn pier_speech_transcribe(
        id: *const c_char,
        path: *const c_char,
        language: *const c_char,
        context: *mut c_void,
        callback: Callback,
    );
    fn pier_speech_cancel(id: *const c_char);
}

#[derive(Clone, Serialize)]
pub struct SpeechResult {
    text: String,
    error: Option<String>,
}

unsafe fn read_result(text: *const c_char, error: *const c_char) -> SpeechResult {
    SpeechResult {
        text: if text.is_null() {
            String::new()
        } else {
            CStr::from_ptr(text).to_string_lossy().into_owned()
        },
        error: if error.is_null() {
            None
        } else {
            Some(CStr::from_ptr(error).to_string_lossy().into_owned())
        },
    }
}

unsafe extern "C" fn authorized(context: *mut c_void, _text: *const c_char, error: *const c_char) {
    // Native code calls once; taking the Box releases it even if the caller disappeared.
    let sender = Box::from_raw(context.cast::<oneshot::Sender<SpeechResult>>());
    let _ = sender.send(read_result(std::ptr::null(), error));
}

#[tauri::command]
pub async fn system_speech_authorize() -> Result<(), String> {
    let (sender, receiver) = oneshot::channel::<SpeechResult>();
    unsafe { pier_speech_authorize(Box::into_raw(Box::new(sender)).cast(), authorized) };
    let result = receiver.await.map_err(|_| "无法读取系统语音识别权限")?;
    result.error.map_or(Ok(()), Err)
}

struct Recognition {
    output: Channel<SpeechResult>,
    // Private temporary audio is removed on success, failure, cancellation or native timeout.
    _audio: NamedTempFile,
}

unsafe extern "C" fn recognized(context: *mut c_void, text: *const c_char, error: *const c_char) {
    let recognition = Box::from_raw(context.cast::<Recognition>());
    let _ = recognition.output.send(read_result(text, error));
}

#[tauri::command]
pub fn system_speech_transcribe(
    id: String,
    data: String,
    language: String,
    output: Channel<SpeechResult>,
) -> Result<(), String> {
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    if id.is_empty() || id.len() > 128 || language.len() > 64 {
        return Err("语音识别参数无效".into());
    }
    if data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("录音超过 4 MiB，请缩短录音后重试".into());
    }
    let audio = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "录音数据无效")?;
    if audio.is_empty() || audio.len() > MAX_BYTES {
        return Err("录音为空或过大，请重新录音".into());
    }
    let id = CString::new(id).map_err(|_| "语音识别参数无效")?;
    let language = CString::new(language).map_err(|_| "语音识别语言无效")?;
    let mut file = tempfile::Builder::new()
        .prefix("pier-speech-")
        .suffix(".m4a")
        .tempfile()
        .map_err(|_| "无法准备系统识别录音")?;
    file.write_all(&audio).map_err(|_| "无法保存临时录音")?;
    let path =
        CString::new(file.path().as_os_str().as_encoded_bytes()).map_err(|_| "临时录音路径无效")?;
    let recognition = Box::new(Recognition {
        output,
        _audio: file,
    });
    // Native code copies strings synchronously and consumes the context exactly once.
    unsafe {
        pier_speech_transcribe(
            id.as_ptr(),
            path.as_ptr(),
            language.as_ptr(),
            Box::into_raw(recognition).cast(),
            recognized,
        )
    };
    Ok(())
}

#[tauri::command]
pub fn system_speech_cancel(id: String) -> Result<(), String> {
    let id = CString::new(id).map_err(|_| "语音识别参数无效")?;
    unsafe { pier_speech_cancel(id.as_ptr()) };
    Ok(())
}
