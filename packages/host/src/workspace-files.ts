import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import {
	PierProtocolError,
	type WorkspaceFileContent,
	type WorkspaceFileEntry,
	type WorkspaceFilesResult,
} from "@pier/protocol";

/** Most entries returned for one directory; the rest are dropped and `truncated` is set. */
export const MAX_DIRECTORY_ENTRIES = 2000;

/** Entries never listed: version-control internals that are large and not useful to browse. */
const HIDDEN_NAMES = new Set([".git", ".hg", ".svn"]);

/**
 * Normalize a client-supplied directory path relative to the workspace root.
 * Accepts "", ".", "src", "src/lib/" and backslash separators; rejects absolute
 * paths and any `..` segment. Returns the path joined with "/" ("" for the root).
 */
export function normalizeRelativePath(path: string | undefined): string {
	if (!path) return "";
	if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith("/") || path.startsWith("\\")) {
		throw new PierProtocolError("BAD_REQUEST", "Path must be relative to the workspace");
	}
	const segments = path.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
	if (segments.some((s) => s === ".." || s.includes("\0"))) {
		throw new PierProtocolError("BAD_REQUEST", "Path must stay inside the workspace");
	}
	return segments.join("/");
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function compareEntries(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
	const dirA = a.kind === "directory" ? 0 : 1;
	const dirB = b.kind === "directory" ? 0 : 1;
	if (dirA !== dirB) return dirA - dirB;
	const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	return byName || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

async function describe(root: string, dir: string, relDir: string, dirent: Dirent): Promise<WorkspaceFileEntry> {
	const path = relDir ? `${relDir}/${dirent.name}` : dirent.name;
	const full = join(dir, dirent.name);
	const entry: WorkspaceFileEntry = { name: dirent.name, path, kind: "other" };
	try {
		if (dirent.isSymbolicLink()) {
			entry.symlink = true;
			// Follow the link for display, but only offer to expand links that stay in the workspace.
			const target = await stat(full);
			const real = await realpath(full);
			if (target.isDirectory()) entry.kind = isInside(root, real) ? "directory" : "other";
			else if (target.isFile()) {
				entry.kind = "file";
				entry.size = target.size;
			}
			entry.modifiedAt = target.mtime.toISOString();
			return entry;
		}
		const info = await lstat(full);
		if (info.isDirectory()) entry.kind = "directory";
		else if (info.isFile()) {
			entry.kind = "file";
			entry.size = info.size;
		}
		entry.modifiedAt = info.mtime.toISOString();
	} catch {
		// Broken symlink or a file removed while listing: keep the name, without details.
	}
	return entry;
}

async function workspaceRealRoot(workspaceRoot: string): Promise<string> {
	try {
		return await realpath(workspaceRoot);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `Workspace directory is missing: ${workspaceRoot}`);
	}
}

/** Resolve a normalized relative path (following symlinks) and require it to stay inside `root`. */
async function resolveInside(root: string, relPath: string, what: string): Promise<string> {
	const target = relPath ? join(root, ...relPath.split("/")) : root;
	let real: string;
	try {
		real = await realpath(target);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `No such ${what}: ${relPath || "."}`);
	}
	if (!isInside(root, real)) {
		throw new PierProtocolError("FORBIDDEN", "Path resolves outside the workspace");
	}
	return real;
}

/**
 * List one directory of a workspace. The directory must resolve (after symlinks) to a
 * location inside the workspace root.
 */
export async function listWorkspaceDirectory(workspaceRoot: string, path?: string): Promise<WorkspaceFilesResult> {
	const relDir = normalizeRelativePath(path);
	const root = await workspaceRealRoot(workspaceRoot);
	const real = await resolveInside(root, relDir, "directory");
	let dirents: Dirent[];
	try {
		dirents = await readdir(real, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOTDIR") throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${relDir}`);
		if (code === "ENOENT") throw new PierProtocolError("NOT_FOUND", `No such directory: ${relDir || "."}`);
		if (code === "EACCES" || code === "EPERM") {
			throw new PierProtocolError("FORBIDDEN", `Permission denied: ${relDir || "."}`);
		}
		throw error;
	}
	const visible = dirents.filter((d) => !HIDDEN_NAMES.has(d.name));
	const entries = await Promise.all(visible.map((d) => describe(root, real, relDir, d)));
	entries.sort(compareEntries);
	const truncated = entries.length > MAX_DIRECTORY_ENTRIES;
	return {
		path: relDir,
		entries: truncated ? entries.slice(0, MAX_DIRECTORY_ENTRIES) : entries,
		...(truncated ? { truncated: true, total: entries.length } : {}),
	};
}

/** Most bytes of a text file returned by `workspace.readFile`; longer files are truncated. */
export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
/** Largest image returned by `workspace.readFile`; larger images come back without data. */
export const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".svg": "image/svg+xml",
};

/** Bytes checked for NUL when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

async function readHead(file: string, limit: number): Promise<Buffer> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(limit);
		let filled = 0;
		while (filled < limit) {
			const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
			if (!bytesRead) break;
			filled += bytesRead;
		}
		return buffer.subarray(0, filled);
	} finally {
		await handle.close();
	}
}

/**
 * Decode UTF-8 text, or undefined for binary data. When `cut`, the bytes are the start of a
 * longer file, so a multi-byte character split at the end is dropped instead of rejected.
 */
function decodeText(bytes: Buffer, cut: boolean): string | undefined {
	if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut });
	} catch {
		return undefined;
	}
}

/**
 * Read one file of a workspace for preview. The file must resolve (after symlinks) to a
 * regular file inside the workspace root. UTF-8 text is returned up to
 * {@link MAX_TEXT_PREVIEW_BYTES}; common image formats are returned base64-encoded up to
 * {@link MAX_IMAGE_PREVIEW_BYTES}; anything else is reported as `binary` without content.
 */
export async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<WorkspaceFileContent> {
	const relPath = normalizeRelativePath(path);
	if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Not a file: .");
	const root = await workspaceRealRoot(workspaceRoot);
	const real = await resolveInside(root, relPath, "file");
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(real);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `No such file: ${relPath}`);
	}
	if (!info.isFile()) throw new PierProtocolError("BAD_REQUEST", `Not a file: ${relPath}`);
	const base = { path: relPath, size: info.size, modifiedAt: info.mtime.toISOString() };
	const mimeType = IMAGE_TYPES[extname(relPath).toLowerCase()];
	try {
		if (mimeType) {
			if (info.size > MAX_IMAGE_PREVIEW_BYTES) return { ...base, kind: "image", mimeType, tooLarge: true };
			const bytes = await readHead(real, MAX_IMAGE_PREVIEW_BYTES + 1);
			if (bytes.length > MAX_IMAGE_PREVIEW_BYTES) return { ...base, kind: "image", mimeType, tooLarge: true };
			return { ...base, size: bytes.length, kind: "image", mimeType, data: bytes.toString("base64") };
		}
		const bytes = await readHead(real, MAX_TEXT_PREVIEW_BYTES + 1);
		const truncated = bytes.length > MAX_TEXT_PREVIEW_BYTES;
		const text = decodeText(truncated ? bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES) : bytes, truncated);
		if (text === undefined) return { ...base, kind: "binary" };
		return { ...base, kind: "text", text, ...(truncated ? { truncated: true } : {}) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new PierProtocolError("NOT_FOUND", `No such file: ${relPath}`);
		if (code === "EACCES" || code === "EPERM")
			throw new PierProtocolError("FORBIDDEN", `Permission denied: ${relPath}`);
		if (code === "EISDIR") throw new PierProtocolError("BAD_REQUEST", `Not a file: ${relPath}`);
		throw error;
	}
}
