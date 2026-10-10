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

/** Only the host's path-boundary error can offer authorization; OS permissions cannot. */
export function filePreviewAuthorizationPath(error: unknown): string | undefined {
	const { code, data } = (error ?? {}) as { code?: string; data?: { reason?: string; resolvedPath?: unknown } };
	if (code !== "FORBIDDEN" || data?.reason !== "OUTSIDE_ALLOWED_ROOTS") return undefined;
	return typeof data.resolvedPath === "string" && data.resolvedPath ? data.resolvedPath : undefined;
}

export function filePreviewError(error: unknown, platform?: string): string {
	const code = (error as { code?: string })?.code;
	const data = (error as { data?: { reason?: string } })?.data;
	const message = error instanceof Error ? error.message : "";
	if (code === "NOT_FOUND") return "文件不存在，可能已被移动或删除";
	if (data?.reason === "PREVIEW_TARGET_CHANGED") return "文件指向的实际路径已改变，请重试并重新确认授权";
	if (code === "FORBIDDEN") {
		if (filePreviewAuthorizationPath(error)) {
			return "该文件位于工作区和临时目录之外，需要授权后才能预览";
		}
		if (/outside the workspace/.test(message)) {
			return "该文件位于工作区和临时目录之外。请更新文件所在电脑的 Pier 后授权预览，或将文件放到当前工作区。";
		}
		if (data?.reason === "FILESYSTEM_PERMISSION_DENIED" || /^Permission denied:/.test(message)) {
			return platform === "darwin"
				? "macOS 拒绝读取。请在文件所在电脑的「系统设置 → 隐私与安全性 → 文件与文件夹」中允许 Pier 访问对应目录；若仍受限，可检查「完全磁盘访问权限」，然后重启 Pier 并重试。"
				: "系统拒绝读取该文件，请检查文件和所在目录的读取权限后重试";
		}
		return "没有权限读取该文件";
	}
	if (code === "BAD_REQUEST" || code === "UNSUPPORTED") return "无法预览该文件，请确认路径正确且 Pier Host 已更新";
	return error instanceof Error ? error.message : "文件读取失败";
}
