/**
 * Uploads to and downloads from workspaces (`workspace.readBytes` / `workspace.upload*`, 1.21).
 *
 * Files move in chunks over the host connection, so they work the same for this computer and
 * paired ones. Transfers are listed (with progress and a cancel button) at the bottom of the
 * file panel; uploads run one file at a time, in the order they were added.
 */
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { useSyncExternalStore } from "react";
import type { PierStore } from "./store.tsx";

/** Bytes per request; small enough for smooth progress and cancelling over slow links. */
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;

export type TransferState = "queued" | "running" | "done" | "error" | "cancelled" | "skipped";

export interface Transfer {
	id: number;
	kind: "upload" | "download";
	workspaceId: string;
	/** Workspace-relative path of the file. */
	path: string;
	name: string;
	/** Total bytes, once known. */
	total?: number;
	done: number;
	state: TransferState;
	error?: string;
	/** Where a finished download was saved, when known. */
	savedTo?: string;
}

/** What to do about an upload whose destination already exists. */
export type OverwriteChoice = "overwrite" | "skip" | "cancel";

export interface OverwriteQuestion {
	path: string;
	/** More uploads follow, so the answer can apply to all of them. */
	more: boolean;
}

export interface OverwriteAnswer {
	choice: OverwriteChoice;
	/** Apply the same choice to the remaining conflicts of this batch. */
	all?: boolean;
}

/** A local file to upload and its workspace-relative destination. */
export interface UploadItem {
	file: File;
	path: string;
}

const FINISHED: ReadonlySet<TransferState> = new Set(["done", "error", "cancelled", "skipped"]);

export function transferFinished(transfer: Transfer): boolean {
	return FINISHED.has(transfer.state);
}

class TransferList {
	private items: Transfer[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly cancelled = new Set<number>();
	private nextId = 1;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	snapshot = (): readonly Transfer[] => this.items;

	add(transfer: Omit<Transfer, "id" | "done" | "state"> & Partial<Pick<Transfer, "state">>): Transfer {
		const item: Transfer = { done: 0, state: "queued", ...transfer, id: this.nextId++ };
		this.items = [...this.items, item];
		this.emit();
		return item;
	}

	update(id: number, patch: Partial<Transfer>): void {
		this.items = this.items.map((t) => (t.id === id ? { ...t, ...patch } : t));
		if (patch.state && FINISHED.has(patch.state)) {
			this.cancelled.delete(id);
			// Successful transfers leave the list on their own; failures stay until dismissed.
			if (patch.state === "done" || patch.state === "skipped") setTimeout(() => this.dismiss(id), 4000);
		}
		this.emit();
	}

	/** Ask a running or queued transfer to stop. */
	cancel(id: number): void {
		const item = this.items.find((t) => t.id === id);
		if (!item || FINISHED.has(item.state)) return;
		this.cancelled.add(id);
		if (item.state === "queued") this.update(id, { state: "cancelled" });
	}

	isCancelled(id: number): boolean {
		return this.cancelled.has(id) || this.items.find((t) => t.id === id)?.state === "cancelled";
	}

	dismiss(id: number): void {
		const before = this.items.length;
		this.items = this.items.filter((t) => t.id !== id || !FINISHED.has(t.state));
		if (this.items.length !== before) this.emit();
	}

	/** Remove every finished transfer of a workspace. */
	clearFinished(workspaceId: string): void {
		this.items = this.items.filter((t) => t.workspaceId !== workspaceId || !FINISHED.has(t.state));
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const transfers = new TransferList();

/** The transfers of one workspace, oldest first. */
export function useTransfers(workspaceId: string): Transfer[] {
	const all = useSyncExternalStore(transfers.subscribe, transfers.snapshot);
	return all.filter((t) => t.workspaceId === workspaceId);
}

class CancelledError extends Error {
	constructor() {
		super("已取消");
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof PierProtocolError) {
		if (error.code === "NOT_FOUND") return error.message.startsWith("Upload") ? "上传已失效，请重试" : "文件不存在";
		if (error.code === "FORBIDDEN") return "没有权限，或路径位于工作区之外";
	}
	return error instanceof Error ? error.message : String(error);
}

/** Bytes encoded by a base64 string. */
function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** The file name at the end of a workspace-relative path. */
function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Download a workspace file to this computer: asks where to save it, then copies it in chunks.
 * Resolves once the download ended (or the save dialog was cancelled).
 */
export async function downloadFile(store: PierStore, workspace: WorkspaceInfo, path: string): Promise<void> {
	let client: PierClient;
	try {
		client = store.fileTransferClient(workspace.id);
	} catch (error) {
		store.toast("error", errorMessage(error));
		return;
	}
	const name = baseName(path);
	let sink: Awaited<ReturnType<PierStore["saveLocalFile"]>>;
	try {
		sink = await store.saveLocalFile(name);
	} catch (error) {
		store.toast("error", `无法保存文件：${errorMessage(error)}`);
		return;
	}
	if (!sink) return;
	const item = transfers.add({ kind: "download", workspaceId: workspace.id, path, name, state: "running" });
	let offset = 0;
	let version: string | undefined;
	try {
		for (;;) {
			if (transfers.isCancelled(item.id)) throw new CancelledError();
			const chunk = await client.request("workspace.readBytes", {
				workspaceId: workspace.id,
				path,
				offset,
				length: TRANSFER_CHUNK_BYTES,
			});
			const stamp = `${chunk.size}@${chunk.modifiedAt}`;
			if (version !== undefined && stamp !== version) throw new Error("文件在下载过程中被修改，请重新下载");
			version = stamp;
			if (chunk.data) await sink.write(chunk.data);
			offset += base64Bytes(chunk.data);
			transfers.update(item.id, { total: chunk.size, done: offset });
			if (chunk.eof) break;
		}
		if (transfers.isCancelled(item.id)) throw new CancelledError();
		const savedTo = (await sink.finish()) ?? sink.path;
		transfers.update(item.id, { state: "done", ...(savedTo ? { savedTo } : {}) });
		store.toast("info", savedTo ? `已下载「${name}」到 ${savedTo}` : `已下载「${name}」`);
	} catch (error) {
		await sink.abort().catch(() => {});
		if (error instanceof CancelledError) transfers.update(item.id, { state: "cancelled" });
		else transfers.update(item.id, { state: "error", error: errorMessage(error) });
	}
}

/**
 * Upload local files into a workspace, one at a time. `ask` decides what to do when a
 * destination already exists; answering `cancel` stops the remaining uploads of this batch.
 */
export async function uploadFiles(
	store: PierStore,
	workspace: WorkspaceInfo,
	items: UploadItem[],
	ask: (question: OverwriteQuestion) => Promise<OverwriteAnswer>,
): Promise<void> {
	if (!items.length) return;
	let client: PierClient;
	try {
		client = store.fileTransferClient(workspace.id);
	} catch (error) {
		store.toast("error", errorMessage(error));
		return;
	}
	const queued = items.map((item) => ({
		item,
		transfer: transfers.add({
			kind: "upload",
			workspaceId: workspace.id,
			path: item.path,
			name: baseName(item.path),
			total: item.file.size,
		}),
	}));
	let always: OverwriteChoice | undefined;
	let stopped = false;
	for (const [index, { item, transfer }] of queued.entries()) {
		if (stopped || transfers.isCancelled(transfer.id)) {
			transfers.update(transfer.id, { state: "cancelled" });
			continue;
		}
		transfers.update(transfer.id, { state: "running" });
		let uploadId: string | undefined;
		try {
			const start = (overwrite: boolean) =>
				client.request("workspace.uploadStart", {
					workspaceId: workspace.id,
					path: item.path,
					size: item.file.size,
					...(overwrite ? { overwrite: true } : {}),
				});
			let started: Awaited<ReturnType<typeof start>>;
			try {
				started = await start(always === "overwrite");
			} catch (error) {
				const kind = (error as PierProtocolError).data as { kind?: string } | undefined;
				if (!(error instanceof PierProtocolError) || error.code !== "CONFLICT" || kind?.kind !== "file") throw error;
				let choice = always;
				if (!choice) {
					const answer = await ask({ path: item.path, more: index < queued.length - 1 });
					choice = answer.choice;
					if (answer.all && choice !== "cancel") always = choice;
				}
				if (choice === "cancel") {
					stopped = true;
					throw new CancelledError();
				}
				if (choice === "skip") {
					transfers.update(transfer.id, { state: "skipped" });
					continue;
				}
				if (transfers.isCancelled(transfer.id)) throw new CancelledError();
				started = await start(true);
			}
			uploadId = started.uploadId;
			const size = Math.min(TRANSFER_CHUNK_BYTES, started.chunkBytes);
			let offset = 0;
			while (offset < item.file.size) {
				if (transfers.isCancelled(transfer.id)) throw new CancelledError();
				const bytes = new Uint8Array(await item.file.slice(offset, offset + size).arrayBuffer());
				if (!bytes.length) throw new Error("读取本地文件失败，文件可能已被修改或删除");
				const { received } = await client.request("workspace.uploadChunk", {
					uploadId,
					offset,
					data: bytesToBase64(bytes),
				});
				offset = received;
				transfers.update(transfer.id, { done: offset });
			}
			if (transfers.isCancelled(transfer.id)) throw new CancelledError();
			await client.request("workspace.uploadFinish", { uploadId });
			uploadId = undefined;
			transfers.update(transfer.id, { state: "done", done: item.file.size });
		} catch (error) {
			if (uploadId) void client.request("workspace.uploadCancel", { uploadId }).catch(() => {});
			if (error instanceof CancelledError) transfers.update(transfer.id, { state: "cancelled" });
			else if (error instanceof PierProtocolError && error.code === "CONFLICT") {
				const kind = (error.data as { kind?: string } | undefined)?.kind;
				transfers.update(transfer.id, {
					state: "error",
					error: kind === "directory" ? "同名文件夹已存在" : kind === "file" ? "同名文件已存在" : errorMessage(error),
				});
			} else transfers.update(transfer.id, { state: "error", error: errorMessage(error) });
		}
		store.bumpFiles(workspace.id);
	}
}

/** Join a workspace directory and a relative name with "/". */
export function childPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

/** Local files picked in a file input, placed under `dir` (keeping folder structure). */
export function uploadItemsFromInput(files: FileList | null, dir: string): UploadItem[] {
	return [...(files ?? [])].map((file) => ({ file, path: childPath(dir, file.webkitRelativePath || file.name) }));
}

type Entry = FileSystemEntry;

function readAllEntries(reader: FileSystemDirectoryReader): Promise<Entry[]> {
	return new Promise((resolve, reject) => {
		const all: Entry[] = [];
		const next = () =>
			reader.readEntries((batch) => {
				if (!batch.length) resolve(all);
				else {
					all.push(...batch);
					next();
				}
			}, reject);
		next();
	});
}

async function walk(entry: Entry, path: string, out: UploadItem[]): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
		out.push({ file, path });
		return;
	}
	if (entry.isDirectory) {
		const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
		for (const child of children) await walk(child, `${path}/${child.name}`, out);
	}
}

/**
 * The entries of a drop. Call synchronously in the `drop` handler (the data transfer is only
 * readable there); the returned function lists the files, walking dropped folders.
 */
export function dropEntries(data: DataTransfer): (dir: string) => Promise<UploadItem[]> {
	const entries = [...data.items]
		.filter((item) => item.kind === "file")
		.map((item) => item.webkitGetAsEntry?.())
		.filter((entry): entry is Entry => Boolean(entry));
	const files = [...data.files];
	return async (dir) => {
		if (!entries.length) return files.map((file) => ({ file, path: childPath(dir, file.name) }));
		const out: UploadItem[] = [];
		for (const entry of entries) await walk(entry, childPath(dir, entry.name), out);
		return out;
	};
}

/** Whether a drag carries files from outside the page. */
export function dragHasFiles(data: DataTransfer | null): boolean {
	return Boolean(data && [...data.types].includes("Files"));
}
