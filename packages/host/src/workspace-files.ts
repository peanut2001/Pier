import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { PierProtocolError, type WorkspaceFileEntry, type WorkspaceFilesResult } from "@pier/protocol";

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

/**
 * List one directory of a workspace. The directory must resolve (after symlinks) to a
 * location inside the workspace root.
 */
export async function listWorkspaceDirectory(workspaceRoot: string, path?: string): Promise<WorkspaceFilesResult> {
	const relDir = normalizeRelativePath(path);
	let root: string;
	try {
		root = await realpath(workspaceRoot);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `Workspace directory is missing: ${workspaceRoot}`);
	}
	const target = relDir ? join(root, ...relDir.split("/")) : root;
	let real: string;
	try {
		real = await realpath(target);
	} catch {
		throw new PierProtocolError("NOT_FOUND", `No such directory: ${relDir || "."}`);
	}
	if (!isInside(root, real)) {
		throw new PierProtocolError("FORBIDDEN", "Path resolves outside the workspace");
	}
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
