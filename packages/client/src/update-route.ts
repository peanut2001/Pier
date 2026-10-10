/** Shared desktop and Android choices, stored using the existing mirror prefix setting. */
export const UPDATE_ROUTES = [
	{ id: "github", label: "GitHub 直连", prefix: "" },
	{ id: "ghfast", label: "GHFast", prefix: "https://ghfast.top/" },
	{ id: "gh-proxy", label: "GH-Proxy", prefix: "https://gh-proxy.com/" },
	{ id: "ghproxy", label: "GHProxy", prefix: "https://ghproxy.net/" },
] as const;

/** An empty prefix uses GitHub directly; a mirror receives the full GitHub URL as its path. */
export function normalizeUpdateMirror(value: string): string {
	const prefix = value.trim();
	if (!prefix) return "";
	const invalid = "请输入 HTTPS 加速地址，不要包含账号、密码、查询参数或片段";
	if (/[\s\\]/.test(prefix)) throw new Error(invalid);
	let url: URL;
	try {
		url = new URL(prefix);
	} catch {
		throw new Error(invalid);
	}
	if (
		url.protocol !== "https:" ||
		!url.hostname ||
		url.username ||
		url.password ||
		url.href.includes("?") ||
		url.href.includes("#")
	) {
		throw new Error(invalid);
	}
	return `${url.href.replace(/\/+$/, "")}/`;
}

/** Route both release manifests and assets, preserving custom endpoints and existing mirror URLs. */
export function updateDownloadUrl(original: string, mirrorPrefix: string): string {
	if (!mirrorPrefix) return original;
	const url = new URL(original);
	if (url.protocol !== "https:" || url.hostname !== "github.com") return original;
	return `${normalizeUpdateMirror(mirrorPrefix)}${original}`;
}
