//! Integrated terminals: shells running in pseudo-terminals, streamed to xterm.js.
//!
//! `terminal_spawn` starts the user's shell in a PTY and returns its id. Output flows to the
//! webview over the `Channel` passed at spawn time: raw PTY bytes arrive as `ArrayBuffer`s
//! (xterm.js decodes UTF-8 itself, so split multi-byte sequences are fine), and a final JSON
//! message `{"type":"exit","code":…}` reports that the shell ended. These terminals are
//! local to the desktop app and do not go through the Pier Host or its protocol.
//!
//! The host sidecar has its own `TerminalManager` (see `host.rs`) for the terminals it runs
//! for its clients (`terminal.*` in the Pier protocol); the webview's `terminal_kill_all`
//! never touches those.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

const READ_BUFFER: usize = 64 * 1024;
/// After the shell exits, how long to keep draining output before reporting the exit.
const DRAIN_GRACE: Duration = Duration::from_millis(500);

/// Holds the reader back while its consumer catches up (flow control for terminals whose
/// output crosses a network). Opening it for good lets a parked reader finish.
#[derive(Default)]
struct Gate {
    paused: Mutex<bool>,
    changed: Condvar,
}

impl Gate {
    fn set(&self, paused: bool) {
        *self.paused.lock().unwrap_or_else(|e| e.into_inner()) = paused;
        self.changed.notify_all();
    }

    fn wait_open(&self) {
        let mut paused = self.paused.lock().unwrap_or_else(|e| e.into_inner());
        while *paused {
            paused = self.changed.wait(paused).unwrap_or_else(|e| e.into_inner());
        }
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    gate: Arc<Gate>,
    /// Input for the writer thread. Writes can block (a paste into a program that is not
    /// reading), and commands run on the main thread, so they only queue here, in order.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next_id: Arc<AtomicU32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedTerminal {
    pub(crate) id: u32,
    /// The shell program, for the tab title.
    pub(crate) shell: String,
    pub(crate) cwd: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum TerminalEvent {
    Exit { code: Option<u32> },
}

/// What a terminal reports, in order: output chunks, then exactly one `Exit`.
pub enum Output {
    Data(Vec<u8>),
    Exit(Option<u32>),
}

/// Delivers output; returns `false` once nobody listens any more.
pub(crate) type Sink = Arc<dyn Fn(Output) -> bool + Send + Sync>;

fn channel_sink(channel: Channel<InvokeResponseBody>) -> Sink {
    Arc::new(move |output| match output {
        Output::Data(bytes) => channel.send(InvokeResponseBody::Raw(bytes)).is_ok(),
        Output::Exit(code) => serde_json::to_string(&TerminalEvent::Exit { code })
            .map(|json| channel.send(InvokeResponseBody::Json(json)).is_ok())
            .unwrap_or(false),
    })
}

impl TerminalManager {
    fn lock(&self) -> MutexGuard<'_, HashMap<u32, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn spawn(
        &self,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        output: Sink,
    ) -> Result<SpawnedTerminal, String> {
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("无法创建伪终端：{e}"))?;

        let cwd = cwd
            .filter(|dir| Path::new(dir).is_dir())
            .or_else(home_dir)
            .unwrap_or_else(|| ".".into());
        let (mut command, shell) = shell_command();
        command.cwd(&cwd);
        clean_env(&mut command);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Pier");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("无法启动 {shell}：{e}"))?;
        // Only the child may hold the slave side, so the reader sees EOF once the shell exits.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("无法读取终端输出：{e}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("无法写入终端：{e}"))?;
        let killer = child.clone_killer();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;

        let gate = Arc::new(Gate::default());
        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        thread::Builder::new()
            .name(format!("terminal-{id}-writer"))
            .spawn(move || {
                // Ends when the session (and with it the sender) is dropped.
                for bytes in input_rx {
                    if writer
                        .write_all(&bytes)
                        .and_then(|()| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|e| format!("无法启动终端线程：{e}"))?;

        self.lock().insert(
            id,
            Session {
                master: pair.master,
                gate: gate.clone(),
                input,
                killer,
            },
        );

        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        let reader_output = output.clone();
        let reader_gate = gate.clone();
        thread::Builder::new()
            .name(format!("terminal-{id}-reader"))
            .spawn(move || {
                let mut buf = vec![0u8; READ_BUFFER];
                loop {
                    reader_gate.wait_open();
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if !reader_output(Output::Data(buf[..n].to_vec())) {
                                break;
                            }
                        }
                    }
                }
                let _ = drained_tx.send(());
            })
            .map_err(|e| format!("无法启动终端线程：{e}"))?;

        let sessions = self.sessions.clone();
        thread::Builder::new()
            .name(format!("terminal-{id}-wait"))
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code());
                // A paused reader must still drain the last output and see EOF.
                gate.set(false);
                // Let the reader deliver what the shell printed last. On Windows the ConPTY
                // only reaches EOF once the master is dropped, so this simply times out.
                let _ = drained_rx.recv_timeout(DRAIN_GRACE);
                let session = sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                drop(session);
                output(Output::Exit(code));
            })
            .map_err(|e| format!("无法启动终端线程：{e}"))?;

        Ok(SpawnedTerminal { id, shell, cwd })
    }

    pub(crate) fn write(&self, id: u32, bytes: Vec<u8>) -> Result<(), String> {
        let sessions = self.lock();
        let session = sessions.get(&id).ok_or("终端已关闭")?;
        session
            .input
            .send(bytes)
            .map_err(|_| "终端已关闭".to_string())
    }

    pub(crate) fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.lock();
        let session = sessions.get(&id).ok_or("终端已关闭")?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("调整终端大小失败：{e}"))
    }

    /// Stop or resume reading the shell's output; a paused shell blocks once the PTY's buffer
    /// is full, so a slow consumer slows the program down instead of piling up output.
    pub(crate) fn pause(&self, id: u32, paused: bool) {
        if let Some(session) = self.lock().get(&id) {
            session.gate.set(paused);
        }
    }

    /// Hang up the shell. The wait thread reports the exit and cleans up.
    pub(crate) fn kill(&self, id: u32) {
        let mut sessions = self.lock();
        if let Some(session) = sessions.get_mut(&id) {
            let _ = session.killer.kill();
        }
    }

    /// Hang up every shell (app exit, or the webview reloaded and lost its terminals).
    pub fn kill_all(&self) {
        let mut sessions = self.lock();
        for session in sessions.values_mut() {
            let _ = session.killer.kill();
            session.gate.set(false);
        }
        // Dropping the masters also hangs up anything else attached to the terminals.
        sessions.clear();
    }
}

fn home_dir() -> Option<String> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(var)
        .ok()
        .filter(|dir| Path::new(dir).is_dir())
}

/// The user's shell: `$SHELL` as a login shell on Unix (so macOS GUI apps get the full
/// `PATH`), PowerShell on Windows.
fn shell_command() -> (CommandBuilder, String) {
    if cfg!(windows) {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        (command, "powershell".into())
    } else {
        let command = CommandBuilder::new_default_prog();
        let shell = command.get_shell();
        let name = shell.rsplit('/').next().unwrap_or(&shell).to_string();
        (command, name)
    }
}

/// Undo what an AppImage runtime injects into the environment, so the shell (and anything
/// run from it) uses the system libraries and tools rather than the bundled ones.
fn clean_env(command: &mut CommandBuilder) {
    for (key, value) in crate::appimage_env::child_env() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        }
    }
}

/// Bytes for the PTY. `binary` input (xterm's `onBinary`, e.g. some mouse reports) carries
/// one byte per char.
pub(crate) fn input_bytes(data: String, binary: bool) -> Vec<u8> {
    if binary {
        data.chars().map(|c| c as u32 as u8).collect()
    } else {
        data.into_bytes()
    }
}

#[tauri::command]
pub fn terminal_spawn(
    manager: State<'_, TerminalManager>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
) -> Result<SpawnedTerminal, String> {
    manager.spawn(cwd, cols, rows, channel_sink(output))
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    id: u32,
    data: String,
    binary: Option<bool>,
) -> Result<(), String> {
    manager.write(id, input_bytes(data, binary == Some(true)))
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(manager: State<'_, TerminalManager>, id: u32) {
    manager.kill(id);
}

#[tauri::command]
pub fn terminal_kill_all(manager: State<'_, TerminalManager>) {
    manager.kill_all();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    struct Collected {
        data: Vec<u8>,
        exit: Option<Option<u32>>,
    }

    fn spawn(manager: &TerminalManager, cwd: Option<String>) -> (u32, Arc<Mutex<Collected>>) {
        let collected = Arc::new(Mutex::new(Collected {
            data: Vec::new(),
            exit: None,
        }));
        let sink_state = collected.clone();
        let sink: Sink = Arc::new(move |output| {
            let mut state = sink_state.lock().unwrap();
            match output {
                Output::Data(bytes) => state.data.extend(bytes),
                Output::Exit(code) => state.exit = Some(code),
            }
            true
        });
        let spawned = manager.spawn(cwd, 80, 24, sink).expect("spawn");
        (spawned.id, collected)
    }

    fn wait_for(collected: &Mutex<Collected>, done: impl Fn(&Collected) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if done(&collected.lock().unwrap()) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn runs_the_shell_in_the_requested_directory_and_reports_the_exit_code() {
        let manager = TerminalManager::default();
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let (id, collected) = spawn(&manager, Some(dir.to_string_lossy().into_owned()));
        manager
            .write(id, b"echo \"pier-$((20+22)):$(pwd)\"; exit 3\r".to_vec())
            .unwrap();
        assert!(
            wait_for(&collected, |c| c.exit.is_some()),
            "shell did not exit"
        );
        let state = collected.lock().unwrap();
        let text = String::from_utf8_lossy(&state.data);
        assert!(
            text.contains(&format!("pier-42:{}", dir.display())),
            "output: {text}"
        );
        assert_eq!(state.exit, Some(Some(3)));
        assert!(manager.lock().is_empty(), "session not cleaned up");
    }

    #[test]
    fn resize_and_kill() {
        let manager = TerminalManager::default();
        let (id, collected) = spawn(&manager, None);
        manager.resize(id, 100, 30).unwrap();
        manager.write(id, b"stty size\r".to_vec()).unwrap();
        assert!(
            wait_for(&collected, |c| String::from_utf8_lossy(&c.data)
                .contains("30 100")),
            "size not applied: {}",
            String::from_utf8_lossy(&collected.lock().unwrap().data)
        );
        manager.kill(id);
        assert!(
            wait_for(&collected, |c| c.exit.is_some()),
            "kill did not end the shell"
        );
        assert!(manager.write(id, b"x".to_vec()).is_err());
    }

    #[test]
    fn pause_holds_output_back_until_resumed_and_kill_still_ends_it() {
        let manager = TerminalManager::default();
        let (id, collected) = spawn(&manager, None);
        manager.write(id, b"echo ready\r".to_vec()).unwrap();
        assert!(wait_for(&collected, |c| String::from_utf8_lossy(&c.data)
            .contains("ready\r\n")));
        manager.pause(id, true);
        // A read already in progress still completes: give it something, then let it park.
        manager.write(id, b"\r".to_vec()).unwrap();
        thread::sleep(Duration::from_millis(300));
        let before = collected.lock().unwrap().data.len();
        manager
            .write(id, b"echo \"held-$((6*7))\"\r".to_vec())
            .unwrap();
        thread::sleep(Duration::from_millis(500));
        let paused =
            String::from_utf8_lossy(&collected.lock().unwrap().data[before..]).into_owned();
        assert!(!paused.contains("held-42"), "output while paused: {paused}");
        manager.pause(id, false);
        assert!(wait_for(&collected, |c| String::from_utf8_lossy(&c.data)
            .contains("held-42")));

        manager.pause(id, true);
        manager.kill(id);
        assert!(
            wait_for(&collected, |c| c.exit.is_some()),
            "kill did not end a paused shell"
        );
    }
}
