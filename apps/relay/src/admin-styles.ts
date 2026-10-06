/** Styles of the admin panel (the Pier palette, light and dark). */
export const STYLES = `
:root {
	--bg-app: #eef0f4; --bg: #ffffff; --bg-elevated: #f7f8fa; --bg-hover: rgba(15, 23, 42, 0.045);
	--bg-active: rgba(15, 23, 42, 0.07); --border: rgba(15, 23, 42, 0.08); --border-strong: rgba(15, 23, 42, 0.14);
	--text: #13161c; --text-muted: #5a6170; --text-faint: #9aa0ac;
	--accent: #11968c; --accent-text: #0d7f77; --accent-soft: rgba(17, 150, 140, 0.1); --accent-ring: rgba(17, 150, 140, 0.3);
	--danger: #d93b3b; --danger-soft: rgba(217, 59, 59, 0.08);
	--warn: #a16207; --warn-soft: rgba(214, 158, 46, 0.13); --ok: #15803d; --ok-soft: rgba(22, 163, 74, 0.1);
	--shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px rgba(15, 23, 42, 0.05);
	--mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg-app: #08090c; --bg: #111217; --bg-elevated: #16171d; --bg-hover: rgba(255, 255, 255, 0.045);
		--bg-active: rgba(255, 255, 255, 0.08); --border: rgba(255, 255, 255, 0.07); --border-strong: rgba(255, 255, 255, 0.13);
		--text: #ededf0; --text-muted: #9a9ca8; --text-faint: #686a75;
		--accent: #2ab5aa; --accent-text: #5fd6cb; --accent-soft: rgba(42, 181, 170, 0.13); --accent-ring: rgba(42, 181, 170, 0.4);
		--danger: #f06464; --danger-soft: rgba(240, 100, 100, 0.12);
		--warn: #e0b04f; --warn-soft: rgba(224, 176, 79, 0.12); --ok: #4ade80; --ok-soft: rgba(74, 222, 128, 0.1);
		--shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 20px rgba(0, 0, 0, 0.25);
	}
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
	background: var(--bg-app); color: var(--text); font-size: 14px; line-height: 1.55;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
	-webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--accent-text); text-decoration: none; }
.boot { display: grid; place-items: center; min-height: 100vh; color: var(--text-muted); }
.icon { width: 18px; height: 18px; display: inline-block; flex: none; }
.icon svg { width: 100%; height: 100%; display: block; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--text-muted); }
.faint { color: var(--text-faint); }
.small { font-size: 12.5px; }

.auth { min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; }
.auth-card { width: 100%; max-width: 400px; background: var(--bg); border: 1px solid var(--border); border-radius: 20px; padding: 30px 28px 26px; box-shadow: var(--shadow); }
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark { width: 38px; height: 38px; border-radius: 11px; background: linear-gradient(135deg, #3b82f6, var(--accent)); display: grid; place-items: center; color: #fff; flex: none; }
.brand-mark .icon { width: 22px; height: 22px; }
.brand-name { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.brand-sub { font-size: 12px; color: var(--text-muted); }
.auth h1 { font-size: 20px; margin: 24px 0 6px; letter-spacing: -0.01em; }
.auth p.lead { margin: 0 0 18px; color: var(--text-muted); font-size: 13px; }
.tabs { display: flex; gap: 4px; padding: 4px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 12px; margin: 22px 0 18px; }
.tabs button { flex: 1; border: 0; background: none; padding: 7px 0; border-radius: 9px; cursor: pointer; color: var(--text-muted); font-weight: 550; }
.tabs button.on { background: var(--bg); color: var(--text); box-shadow: var(--shadow); }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.field label { font-size: 13px; font-weight: 550; }
.field .hint { font-size: 12px; color: var(--text-faint); }
.input {
	width: 100%; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--bg);
	outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
textarea.input { min-height: 80px; resize: vertical; font-family: var(--mono); font-size: 12.5px; }
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.input[readonly] { background: var(--bg-elevated); }
.btn {
	display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 14px; border-radius: 10px;
	border: 1px solid var(--border-strong); background: var(--bg); cursor: pointer; font-weight: 550; white-space: nowrap;
	transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}
.btn:hover { background: var(--bg-hover); }
.btn:disabled { opacity: 0.55; cursor: default; }
.btn .icon { width: 15px; height: 15px; }
.btn.primary { background: linear-gradient(135deg, #3b82f6, var(--accent)); border-color: transparent; color: #fff; }
.btn.primary:hover { filter: brightness(1.06); }
.btn.danger { color: var(--danger); }
.btn.danger:hover { background: var(--danger-soft); border-color: var(--danger); }
.btn.solid-danger { background: var(--danger); border-color: transparent; color: #fff; }
.btn.block { width: 100%; padding: 10px 14px; margin-top: 4px; }
.btn.sm { padding: 4px 10px; font-size: 12.5px; border-radius: 8px; }
.btn.ghost { border-color: transparent; background: none; }
.btn.ghost:hover { background: var(--bg-hover); }
.alert { padding: 10px 13px; border-radius: 10px; font-size: 13px; margin-bottom: 14px; }
.alert.error { background: var(--danger-soft); color: var(--danger); }
.alert.ok { background: var(--ok-soft); color: var(--ok); }
.alert.warn { background: var(--warn-soft); color: var(--warn); }
.alert.info { background: var(--accent-soft); color: var(--accent-text); }
.alert a { font-weight: 600; text-decoration: underline; }
.auth-foot { margin-top: 18px; text-align: center; font-size: 12px; color: var(--text-faint); }

.shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
.side { background: var(--bg); border-right: 1px solid var(--border); padding: 18px 12px; display: flex; flex-direction: column; gap: 18px; position: sticky; top: 0; height: 100vh; }
.side .brand { padding: 2px 8px 0; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; color: var(--text-muted); font-weight: 550; }
.nav a:hover { background: var(--bg-hover); color: var(--text); }
.nav a.on { background: var(--accent-soft); color: var(--accent-text); }
.nav .count { margin-left: auto; background: var(--danger); color: #fff; font-size: 11px; border-radius: 99px; padding: 0 7px; line-height: 18px; }
.nav-label { font-size: 11.5px; color: var(--text-faint); padding: 10px 10px 4px; font-weight: 600; letter-spacing: 0.04em; }
.side-foot { margin-top: auto; border-top: 1px solid var(--border); padding: 12px 6px 0; display: flex; align-items: center; gap: 10px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-weight: 650; color: #fff; flex: none; background: linear-gradient(135deg, #6366f1, var(--accent)); }
.who { min-width: 0; flex: 1; }
.who .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who .role { font-size: 12px; color: var(--text-faint); }
.main { padding: 28px 36px 48px; min-width: 0; max-width: 1160px; width: 100%; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
.page-head h1 { margin: 0; font-size: 22px; letter-spacing: -0.015em; }
.page-head p { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
.card { background: var(--bg); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); margin-bottom: 18px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px 0; flex-wrap: wrap; }
.card-head h2 { margin: 0; font-size: 15px; }
.card-head p { margin: 2px 0 0; font-size: 12.5px; color: var(--text-muted); }
.card-body { padding: 16px 20px 20px; }
.card-body.flush { padding: 8px 0 4px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { background: var(--bg); border: 1px solid var(--border); border-radius: 16px; padding: 15px 18px; box-shadow: var(--shadow); }
.stat .label { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: 12.5px; font-weight: 550; }
.stat .label .icon { width: 15px; height: 15px; }
.stat .value { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; margin-top: 6px; }
.stat .sub { font-size: 12px; color: var(--text-faint); }
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 99px; background: var(--bg-active); color: var(--text-muted); white-space: nowrap; }
.badge.accent { background: var(--accent-soft); color: var(--accent-text); }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.danger { background: var(--danger-soft); color: var(--danger); }
.badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--text-faint); font-size: 12px; padding: 8px 20px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 11px 20px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
td.actions { text-align: right; white-space: nowrap; }
td.actions .btn + .btn { margin-left: 6px; }
.empty { padding: 34px 20px; text-align: center; color: var(--text-faint); }
.copy-row { display: flex; gap: 8px; }
.copy-row .input { font-family: var(--mono); font-size: 12.5px; }
.steps { margin: 0; padding-left: 20px; color: var(--text-muted); }
.steps li { margin: 5px 0; }
.steps b { color: var(--text); font-weight: 600; }
.modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.mode {
	text-align: left; border: 1.5px solid var(--border-strong); background: var(--bg); border-radius: 14px; padding: 15px; cursor: pointer;
	display: flex; gap: 12px; transition: border-color 0.15s, background 0.15s;
}
.mode:hover { border-color: var(--accent); }
.mode.on { border-color: var(--accent); background: var(--accent-soft); cursor: default; }
.mode .mode-icon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--bg-active); flex: none; }
.mode.on .mode-icon { background: var(--accent); color: #fff; }
.mode .title { font-weight: 650; display: flex; align-items: center; gap: 8px; }
.mode .desc { font-size: 12.5px; color: var(--text-muted); margin-top: 3px; }
.segmented { display: inline-flex; gap: 4px; padding: 4px; border-radius: 12px; background: var(--bg-elevated); border: 1px solid var(--border); flex-wrap: wrap; }
.segmented button { border: 0; background: none; padding: 6px 14px; border-radius: 9px; cursor: pointer; color: var(--text-muted); font-weight: 550; }
.segmented button.on { background: var(--bg); color: var(--text); box-shadow: var(--shadow); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 18px; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 8px 22px; font-size: 13px; margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; }
.form-foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
.inline-form .input { flex: 1; min-width: 180px; }
.reveal { border: 1px dashed var(--accent); background: var(--accent-soft); border-radius: 12px; padding: 14px; margin-top: 14px; }
.reveal p { margin: 0 0 10px; font-size: 13px; }
.row-title { font-weight: 600; }

.backdrop { position: fixed; inset: 0; background: rgba(8, 10, 14, 0.45); display: grid; place-items: center; padding: 16px; z-index: 50; animation: fade 0.15s ease-out; }
.dialog { width: 100%; max-width: 420px; background: var(--bg); border: 1px solid var(--border); border-radius: 18px; padding: 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); animation: pop 0.16s ease-out; }
.dialog h3 { margin: 0 0 8px; font-size: 16px; }
.dialog p { margin: 0 0 14px; color: var(--text-muted); font-size: 13px; }
.dialog .form-foot { padding-top: 8px; }
.toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 60; }
.toast { background: var(--bg); border: 1px solid var(--border-strong); border-left: 3px solid var(--accent); border-radius: 10px; padding: 10px 14px; box-shadow: var(--shadow); font-size: 13px; max-width: 360px; animation: pop 0.16s ease-out; }
.toast.error { border-left-color: var(--danger); }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(0.98); } }

@media (max-width: 860px) {
	.shell { grid-template-columns: 1fr; }
	.side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px; gap: 10px; border-right: 0; border-bottom: 1px solid var(--border); }
	.side .brand-sub, .nav-label { display: none; }
	.nav { flex-direction: row; flex-wrap: wrap; order: 3; width: 100%; }
	.nav a { padding: 6px 10px; }
	.side-foot { margin: 0 0 0 auto; border: 0; padding: 0; }
	.side-foot .who { display: none; }
	.main { padding: 20px 16px 40px; }
	th, td { padding: 10px 14px; }
}
`;
