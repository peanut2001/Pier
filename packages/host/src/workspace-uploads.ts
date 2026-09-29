/**
 * File uploads into workspaces (`workspace.upload*`, 1.21).
 *
 * An upload is written to a hidden temporary file next to its destination and moved into place
 * only once every byte arrived, so an interrupted upload never leaves a half-written file under
 * the real name. Each upload belongs to the connection that started it: only that connection can
 * add to, finish or cancel it, and it is cancelled when the connection closes or sits idle.
 */
import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { PierProtocolError, type WorkspaceFileWriteResult, type WorkspaceUploadStart } from "@pier/protocol";
import { fsError, normalizeRelativePath, resolveInside, workspaceRealRoot } from "./workspace-files.ts";

/** Largest decoded `data` of one `workspace.uploadChunk`. */
export const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** Largest file accepted by `workspace.uploadStart`. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;
/** Uploads in progress per connection. */
export const MAX_UPLOADS_PER_CONNECTION = 8;
/** An upload that receives nothing for this long is cancelled. */
export const UPLOAD_IDLE_MS = 5 * 60 * 1000;

const TEMP_SUFFIX = ".pier-upload";

interface Upload {
	id: string;
	owner: string;
	relPath: string;
	/** Real path of the destination's directory. */
	dir: string;
	name: string;
	temp: string;
	handle: FileHandle;
	size: number;
	received: number;
	overwrite: boolean;
	busy: boolean;
	timer: ReturnType<typeof setTimeout>;
}

export interface WorkspaceUploadsOptions {
	idleMs?: number;
	log?: (message: string) => void;
}

/**
 * Resolve the directory `segments` (relative to `root`) and create the parts that are missing.
 * Existing parts are followed (symlinks included) and must stay inside the workspace.
 */
async function ensureDirectory(root: string, segments: string[]): Promise<string> {
	let dir = root;
	for (let i = 0; i < segments.length; i++) {
		const next = join(dir, segments[i] as string);
		const shown = segments.slice(0, i + 1).join("/");
		let exists = true;
		try {
			await lstat(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") fsError(error, shown);
			exists = false;
		}
		if (!exists) {
			try {
				await mkdir(next);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") fsError(error, shown);
			}
		}
		const real = await resolveInside(root, shown, "directory");
		if (!(await stat(real)).isDirectory()) throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${shown}`);
		dir = real;
	}
	return dir;
}

/** What is at `path` now, without following a final symlink's target kind for files. */
async function existing(path: string): Promise<"none" | "directory" | "file"> {
	try {
		const info = await stat(path);
		return info.isDirectory() ? "directory" : "file";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			// A dangling symlink still occupies the name.
			try {
				await lstat(path);
				return "file";
			} catch {
				return "none";
			}
		}
		throw error;
	}
}

export class WorkspaceUploads {
	private readonly uploads = new Map<string, Upload>();
	private readonly idleMs: number;
	private readonly log: (message: string) => void;
	private closed = false;

	constructor(options: WorkspaceUploadsOptions = {}) {
		this.idleMs = options.idleMs ?? UPLOAD_IDLE_MS;
		this.log = options.log ?? (() => {});
	}

	get count(): number {
		return this.uploads.size;
	}

	async start(
		owner: string,
		workspaceRoot: string,
		path: string,
		size: number,
		overwrite = false,
	): Promise<WorkspaceUploadStart> {
		if (this.closed) throw new PierProtocolError("CONFLICT", "Host is shutting down");
		const relPath = normalizeRelativePath(path);
		if (!relPath) throw new PierProtocolError("BAD_REQUEST", "Not a file: .");
		if (!Number.isSafeInteger(size) || size < 0) throw new PierProtocolError("BAD_REQUEST", "Invalid size");
		if (size > MAX_UPLOAD_BYTES) {
			throw new PierProtocolError("BAD_REQUEST", `File is larger than ${MAX_UPLOAD_BYTES} bytes`);
		}
		let mine = 0;
		for (const upload of this.uploads.values()) if (upload.owner === owner) mine++;
		if (mine >= MAX_UPLOADS_PER_CONNECTION) {
			throw new PierProtocolError("CONFLICT", `At most ${MAX_UPLOADS_PER_CONNECTION} uploads at a time`);
		}
		const segments = relPath.split("/");
		const name = segments.pop() as string;
		const root = await workspaceRealRoot(workspaceRoot);
		const dir = await ensureDirectory(root, segments);
		const target = join(dir, name);
		let kind: Awaited<ReturnType<typeof existing>>;
		try {
			kind = await existing(target);
		} catch (error) {
			fsError(error, relPath);
		}
		if (kind === "directory") throw new PierProtocolError("CONFLICT", `A directory exists at ${relPath}`, { kind });
		if (kind === "file" && !overwrite) throw new PierProtocolError("CONFLICT", `File exists: ${relPath}`, { kind });
		const id = randomUUID();
		const temp = join(dir, `.${name.slice(0, 80)}.${id.slice(0, 8)}${TEMP_SUFFIX}`);
		let handle: FileHandle;
		try {
			handle = await open(temp, "wx");
		} catch (error) {
			fsError(error, relPath);
		}
		const upload: Upload = {
			id,
			owner,
			relPath,
			dir,
			name,
			temp,
			handle,
			size,
			received: 0,
			overwrite,
			busy: false,
			timer: this.idleTimer(id),
		};
		this.uploads.set(id, upload);
		return { uploadId: id, path: relPath, chunkBytes: MAX_UPLOAD_CHUNK_BYTES };
	}

	async chunk(owner: string, uploadId: string, offset: number, data: string): Promise<{ received: number }> {
		const upload = this.take(owner, uploadId);
		try {
			if (offset !== upload.received) {
				throw new PierProtocolError("CONFLICT", `Expected offset ${upload.received}`, { received: upload.received });
			}
			const bytes = Buffer.from(data, "base64");
			if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) {
				throw new PierProtocolError("BAD_REQUEST", `Chunk is larger than ${MAX_UPLOAD_CHUNK_BYTES} bytes`);
			}
			if (upload.received + bytes.length > upload.size) {
				throw new PierProtocolError("BAD_REQUEST", "More data than the announced size");
			}
			let written = 0;
			while (written < bytes.length) {
				const { bytesWritten } = await upload.handle.write(bytes, written, bytes.length - written, offset + written);
				written += bytesWritten;
			}
			upload.received += bytes.length;
			return { received: upload.received };
		} catch (error) {
			if (error instanceof PierProtocolError) throw error;
			await this.discard(upload);
			fsError(error, upload.relPath);
		} finally {
			upload.busy = false;
		}
	}

	async finish(owner: string, uploadId: string): Promise<WorkspaceFileWriteResult> {
		const upload = this.take(owner, uploadId);
		if (upload.received !== upload.size) {
			upload.busy = false;
			throw new PierProtocolError("BAD_REQUEST", `Received ${upload.received} of ${upload.size} bytes`, {
				received: upload.received,
			});
		}
		this.forget(upload);
		const target = join(upload.dir, upload.name);
		try {
			await upload.handle.close();
			const kind = await existing(target);
			if (kind === "directory") {
				throw new PierProtocolError("CONFLICT", `A directory exists at ${upload.relPath}`, { kind });
			}
			if (kind === "file" && !upload.overwrite) {
				throw new PierProtocolError("CONFLICT", `File exists: ${upload.relPath}`, { kind });
			}
			await rename(upload.temp, target);
			const info = await stat(target);
			return { path: upload.relPath, size: info.size, modifiedAt: info.mtime.toISOString() };
		} catch (error) {
			await rm(upload.temp, { force: true }).catch(() => {});
			if (error instanceof PierProtocolError) throw error;
			fsError(error, upload.relPath);
		}
	}

	async cancel(owner: string, uploadId: string): Promise<{ cancelled: boolean }> {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.owner !== owner) return { cancelled: false };
		await this.discard(upload);
		return { cancelled: true };
	}

	/** Cancel the uploads of a connection that went away. */
	connectionClosed(owner: string): void {
		for (const upload of [...this.uploads.values()]) {
			if (upload.owner === owner) void this.discard(upload);
		}
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.uploads.values()].map((upload) => this.discard(upload)));
	}

	/** Look up an upload for `owner` and mark it busy (one request at a time per upload). */
	private take(owner: string, uploadId: string): Upload {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.owner !== owner) {
			throw new PierProtocolError("NOT_FOUND", "Upload not found; it may have expired or been cancelled");
		}
		if (upload.busy) throw new PierProtocolError("CONFLICT", "Upload is busy with another request");
		upload.busy = true;
		clearTimeout(upload.timer);
		upload.timer = this.idleTimer(upload.id);
		return upload;
	}

	private idleTimer(id: string): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			const upload = this.uploads.get(id);
			if (!upload) return;
			this.log(`Upload of ${upload.relPath} expired after ${Math.round(this.idleMs / 1000)}s without data`);
			void this.discard(upload);
		}, this.idleMs);
		timer.unref?.();
		return timer;
	}

	private forget(upload: Upload): void {
		clearTimeout(upload.timer);
		this.uploads.delete(upload.id);
	}

	private async discard(upload: Upload): Promise<void> {
		if (!this.uploads.has(upload.id)) return;
		this.forget(upload);
		await upload.handle.close().catch(() => {});
		await rm(upload.temp, { force: true }).catch(() => {});
	}
}
