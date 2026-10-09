import { defaultUrlTransform } from "react-markdown";

/** File links in agent replies can be paths, file URLs, or source references with line numbers. */
export function markdownFilePath(url: string | undefined, basePath = ""): string | undefined {
	if (!url) return undefined;
	let path = url.trim();
	if (!path || path.startsWith("#") || path.startsWith("//") || path.startsWith("\\\\")) return undefined;
	if (/^file:/i.test(path)) {
		try {
			const file = new URL(path);
			if (file.hostname && file.hostname !== "localhost") return undefined;
			path = file.pathname;
			if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
		} catch {
			return undefined;
		}
	} else if (/^[a-zA-Z][\w+.-]*:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path)) {
		return undefined;
	} else {
		path = path.replace(/#.*$/, "");
	}
	try {
		path = decodeURIComponent(path);
	} catch {
		return undefined;
	}
	path = path.replace(/\\/g, "/").replace(/:\d+(?::\d+)?$/, "");
	if (!path || path.includes("\0") || path.startsWith("//")) return undefined;
	return path.startsWith("/") || /^[a-zA-Z]:\//.test(path) || !basePath ? path : `${basePath}/${path}`;
}

/** Preserve local paths for our components while retaining react-markdown's scheme filtering. */
export function markdownUrlTransform(url: string, key: string): string {
	if (markdownFilePath(url) !== undefined) return url;
	if (key === "src" && /^data:image\/(png|jpe?g|gif|webp|bmp|ico|avif);base64,[a-zA-Z0-9+/=\s]+$/i.test(url)) {
		return url;
	}
	return defaultUrlTransform(url);
}

export function filePreviewError(error: unknown): string {
	const code = (error as { code?: string })?.code;
	if (code === "NOT_FOUND") return "文件不存在，可能已被移动或删除";
	if (code === "FORBIDDEN") return "无法读取该文件，请确认路径位于工作区或临时目录中，且有读取权限";
	if (code === "BAD_REQUEST" || code === "UNSUPPORTED") return "无法预览该文件，请确认路径正确且 Pier Host 已更新";
	return error instanceof Error ? error.message : "文件读取失败";
}
