# Changelog

All notable changes to Pier are documented here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## v0.1.0 — 2026-09-28

The desktop app (milestone M2): run pi coding agents from a native window, with approvals, tool output, and diffs, without opening a terminal. The Pier Host keeps running in the tray when the window is closed.

### Added

- **Desktop app** (`apps/desktop`, milestone M2): a Tauri 2 shell that bundles the Pier Host as a sidecar.
  - The Rust side starts the host, reads its `pier.ready` line, restarts it after crashes (with backoff, giving up after repeated fast failures), keeps a log buffer, and shuts it down gracefully on quit. The host also exits when the shell dies.
  - Closing the window hides Pier in the system tray; agents keep running. A second launch focuses the running instance.
  - The React UI covers workspaces (add, remove, approval policy), sessions (create, open, rename, fork, close), streaming chat with Markdown and code highlighting, collapsible thinking, tool cards (terminal output, edit diffs, file previews), approval and dialog cards, steer / follow-up / abort, image attachments, model and thinking-level switching, context compaction, token and cost totals, and a host log viewer.
- **`@pier/chat-state`**: a pure reducer from snapshots and events to a chat view model, shared by the desktop and (later) mobile apps, with a transcript builder that folds tool results into their calls.
- `pnpm faux-host`: a development host backed by pi's faux model for UI work without real credentials.
- CI builds the desktop shell on Linux, macOS, and Windows; releases attach unsigned desktop bundles.

### Release assets

- Desktop app: `pier-desktop-v0.1.0-linux-x64.deb` and `.AppImage`, `pier-desktop-v0.1.0-darwin-arm64.dmg`, `pier-desktop-v0.1.0-darwin-x64.dmg`, and `pier-desktop-v0.1.0-windows-x64.setup.exe`. Each bundle includes the Pier Host sidecar and pi's runtime assets.
- Standalone host: `pier-host-v0.1.0-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64, as in v0.0.1.
- `SHA256SUMS.txt` lists the checksums of all assets.

Models and credentials come from pi's configuration (`~/.pi/agent`). If no model is available yet, run `pi` once in a terminal and log in.

### Known limitations

- The bundles are not code-signed. On macOS, remove the quarantine attribute (`xattr -dr com.apple.quarantine /Applications/Pier.app`) or allow the app in System Settings → Privacy & Security. On Windows, SmartScreen may ask you to confirm the installer.
- The desktop app has been verified end to end on Linux. The macOS and Windows bundles are built and checked in CI but have not yet been tested on real machines.
- There is no auto-update, autostart, desktop notifications, or session search yet.
- Only local connections are supported. Remote access, pairing, and the mobile app arrive in M3.

## v0.0.1 — 2026-09-28

First developer preview: the Pier Host core (milestones M0 and M1). There is no desktop or mobile app yet; you drive the Host with the `pier-cli` debug client.

### Added

- **Pier Host** (`packages/host`), built on the pi SDK 0.87.1 and reusing pi's configuration (`~/.pi/agent`):
  - workspaces with per-workspace approval policies (`ask` / `smart` / `auto`), stored in `~/.pier/config.json`;
  - an active session pool (create, open, fork, rename, close, idle eviction) that is compatible with `pi --resume`;
  - an extension UI bridge (select / confirm / input / editor, notifications, status, widgets) where the first client to answer wins;
  - the built-in `pier-approval` extension (read-only whitelist, dangerous-command detection, allow once / for this session / deny with a reason);
  - a per-session event log with replay-or-snapshot resume after disconnects, and optional merging of streaming deltas;
  - session file locks and detection of external writes to session files;
  - a local WebSocket gateway on `127.0.0.1` with token authentication and an Origin allowlist.
- **Protocol v1.0** (`packages/protocol`, documented in `docs/protocol.md`).
- **Client library and `pier-cli`** (`packages/client`) with automatic reconnect and seq-based resume.
- **Single-file sidecar builds** made with `bun build --compile`, shipped together with pi's runtime assets.

### Release assets

`pier-host-v0.0.1-<os>-<arch>` archives for linux-x64, linux-arm64, darwin-arm64, darwin-x64, and windows-x64. Each archive contains the `pier-host` executable plus the pi assets it needs next to it; `SHA256SUMS.txt` lists the checksums. The binaries are not code-signed. On macOS, remove the quarantine attribute (`xattr -d com.apple.quarantine pier-host`) or allow the binary in System Settings.

### Known limitations

- Only local connections are supported. Remote access, pairing, and the mobile app arrive in M3.
- The desktop app (M2) is not included yet.
