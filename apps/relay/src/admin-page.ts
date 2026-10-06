/**
 * The admin panel page: one HTML document with inline styles and script, so the relay stays a
 * single file. The script is `panel` (admin-client.ts), type-checked with the DOM types and sent
 * to the browser as its own source text.
 */
import { panel } from "./admin-client.ts";
import { STYLES } from "./admin-styles.ts";

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#11968c"/><circle cx="9" cy="16" r="3.2" fill="#fff"/><circle cx="23" cy="16" r="3.2" fill="#fff"/><path d="M12.5 16h7" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="2.2 2.6"/></svg>`;

/** The script once per process; bundlers may wrap named functions with a `__name` helper. */
let script: string | undefined;

export function adminPage(nonce: string): string {
	script ??= `"use strict";\nvar __name = function (target) { return target; };\n(${panel.toString()})();\n`;
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Pier Relay 管理后台</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">
<style>${STYLES}</style>
</head>
<body>
<div id="app"><div class="boot">正在加载…</div></div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
