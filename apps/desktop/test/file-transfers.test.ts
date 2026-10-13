import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bytesToBase64,
	downloadFile,
	type OverwriteAnswer,
	type PasteConflictQuestion,
	pasteNameError,
	pasteWorkspaceEntries,
	TRANSFER_CHUNK_BYTES,
	transfers,
	uploadFiles,
	uploadItemsFromInput,
} from "../src/lib/file-transfers.ts";
import type { PierStore } from "../src/lib/store.tsx";
import {
	clearWorkspaceClipboard,
	getWorkspaceClipboard,
	setWorkspaceClipboard,
	type WorkspaceClipboardState,
} from "../src/lib/workspace-clipboard.ts";

const workspace = { id: "w1", path: "/ws", name: "ws" } as WorkspaceInfo;

interface Call {
	method: string;
	params: Record<string, unknown>;
}

function fakeStore(handle: (call: Call) => unknown, sink?: { writes: string[]; finished: boolean; aborted: boolean }) {
	const calls: Call[] = [];
	const client = {
		request: async (method: string, params: Record<string, unknown>) => {
			const call = { method, params };
			calls.push(call);
			return handle(call);
		},
	};
	const store = {
		fileTransferClient: () => client,
		nodeOf: () => "local",
		requireNativeFileTransfers: vi.fn(),
		closeMovedFilePreview: vi.fn(),
		toast: vi.fn(),
		bumpFiles: vi.fn(),
		saveLocalFile: async () =>
			sink
				? {
						path: "/local/out.bin",
						write: async (data: string) => {
							sink.writes.push(data);
						},
						finish: async () => {
							sink.finished = true;
							return "/local/out.bin";
						},
						abort: async () => {
							sink.aborted = true;
						},
					}
				: null,
	} as unknown as PierStore;
	return { store, calls };
}

beforeEach(() => {
	for (const t of transfers.snapshot()) transfers.cancel(t.id);
	transfers.clearFinished("w1");
	clearWorkspaceClipboard();
});

describe("bytesToBase64", () => {
	it("encodes large arrays", () => {
		const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
		expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
	});
});

describe("uploadItemsFromInput", () => {
	it("keeps folder structure under the target directory", () => {
		const a = new File(["a"], "a.txt");
		const b = new File(["b"], "b.txt");
		Object.defineProperty(b, "webkitRelativePath", { value: "dir/sub/b.txt" });
		const list = [a, b] as unknown as FileList;
		expect(uploadItemsFromInput(list, "src").map((i) => i.path)).toEqual(["src/a.txt", "src/dir/sub/b.txt"]);
		expect(uploadItemsFromInput(list, "").map((i) => i.path)).toEqual(["a.txt", "dir/sub/b.txt"]);
	});
});

describe("uploadFiles", () => {
	it("uploads in chunks and asks before replacing a file", async () => {
		const big = new Uint8Array(TRANSFER_CHUNK_BYTES + 10).fill(7);
		let conflicts = 0;
		const { store, calls } = fakeStore(({ method, params }) => {
			if (method === "workspace.uploadStart") {
				if (params.path === "d/exists.txt" && !params.overwrite) {
					conflicts++;
					throw new PierProtocolError("CONFLICT", "exists", { kind: "file" });
				}
				return { uploadId: `u-${params.path}`, path: params.path, chunkBytes: 4 * 1024 * 1024 };
			}
			if (method === "workspace.uploadChunk") {
				return { received: (params.offset as number) + Buffer.from(params.data as string, "base64").length };
			}
			return { path: "x", size: 0, modifiedAt: "" };
		});
		const questions: string[] = [];
		await uploadFiles(
			store,
			workspace,
			[
				{ file: new File([big], "big.bin"), path: "d/big.bin" },
				{ file: new File(["new"], "exists.txt"), path: "d/exists.txt" },
			],
			async (q): Promise<OverwriteAnswer> => {
				questions.push(`${q.path}:${q.more}`);
				return { choice: "overwrite" };
			},
		);
		expect(questions).toEqual(["d/exists.txt:false"]);
		expect(conflicts).toBe(1);
		const chunks = calls.filter((c) => c.method === "workspace.uploadChunk");
		expect(chunks.map((c) => [c.params.uploadId, c.params.offset])).toEqual([
			["u-d/big.bin", 0],
			["u-d/big.bin", TRANSFER_CHUNK_BYTES],
			["u-d/exists.txt", 0],
		]);
		expect(calls.filter((c) => c.method === "workspace.uploadFinish")).toHaveLength(2);
		expect(transfers.snapshot().map((t) => t.state)).toEqual(["done", "done"]);
	});

	it("stops the batch when the user cancels at a conflict", async () => {
		const { store, calls } = fakeStore(({ method, params }) => {
			if (method === "workspace.uploadStart") throw new PierProtocolError("CONFLICT", "exists", { kind: "file" });
			return params;
		});
		await uploadFiles(
			store,
			workspace,
			[
				{ file: new File(["1"], "a"), path: "a" },
				{ file: new File(["2"], "b"), path: "b" },
			],
			async () => ({ choice: "cancel" }),
		);
		expect(calls.map((c) => c.method)).toEqual(["workspace.uploadStart"]);
		expect(transfers.snapshot().map((t) => t.state)).toEqual(["cancelled", "cancelled"]);
	});
});

describe("downloadFile", () => {
	it("copies a file in chunks and notices changes", async () => {
		const sink = { writes: [] as string[], finished: false, aborted: false };
		const { store } = fakeStore(({ params }) => {
			const offset = params.offset as number;
			const data = offset === 0 ? Buffer.from("hello ") : Buffer.from("world");
			return { path: "f.txt", size: 11, modifiedAt: "t1", offset, data: data.toString("base64"), eof: offset > 0 };
		}, sink);
		await downloadFile(store, workspace, "dir/f.txt");
		expect(Buffer.concat(sink.writes.map((w) => Buffer.from(w, "base64"))).toString()).toBe("hello world");
		expect(sink.finished).toBe(true);
		expect(transfers.snapshot()[0]).toMatchObject({
			name: "f.txt",
			state: "done",
			done: 11,
			savedTo: "/local/out.bin",
		});

		const changed = { writes: [] as string[], finished: false, aborted: false };
		const second = fakeStore(({ params }) => {
			const offset = params.offset as number;
			return { path: "f.txt", size: 11, modifiedAt: offset ? "t2" : "t1", offset, data: "aGk=", eof: false };
		}, changed);
		await downloadFile(second.store, workspace, "f.txt");
		expect(changed.aborted).toBe(true);
		expect(transfers.snapshot().at(-1)).toMatchObject({ state: "error", error: "文件在下载过程中被修改，请重新下载" });
	});
});

const copied = (mode: "copy" | "move" = "copy"): WorkspaceClipboardState => ({
	mode,
	sourceWorkspaceId: "source",
	entries: [{ path: "src/a.bin", name: "a.bin", kind: "file" }],
});

describe("pasteWorkspaceEntries", () => {
	it.each(["copy", "move"] as const)(
		"prompts for a new name when %s pastes into the source directory",
		async (mode) => {
			const { store, calls } = fakeStore(({ params }) => {
				if (params.path === params.destinationPath)
					throw new PierProtocolError("BAD_REQUEST", "Source and destination are the same path");
				return {};
			});
			setWorkspaceClipboard(mode, "w1", [{ path: ".env.example", name: ".env.example", kind: "file" }]);
			const clipboard = getWorkspaceClipboard() as WorkspaceClipboardState;
			const ask = vi.fn(async () => ({ choice: "rename" as const, name: " .env.local " }));
			await pasteWorkspaceEntries(store, clipboard, workspace, "", ask);
			expect(ask).toHaveBeenCalledExactlyOnceWith({
				path: ".env.example",
				more: false,
				canOverwrite: false,
				suggestedName: ".env (副本).example",
			});
			expect(calls.map((call) => call.params.destinationPath)).toEqual([".env.example", ".env.local"]);
			expect(calls.every((call) => call.params.path === ".env.example" && call.params.overwrite === false)).toBe(true);
			expect(transfers.snapshot()).toMatchObject([{ path: ".env.local", name: ".env.local", state: "done" }]);
			expect(getWorkspaceClipboard()).toBe(mode === "move" ? undefined : clipboard);
			expect(store.closeMovedFilePreview).toHaveBeenCalledTimes(mode === "move" ? 1 : 0);
			expect(store.toast).toHaveBeenCalledWith("info", `已${mode === "move" ? "移动" : "复制"} 1 项`);
		},
	);

	it.each([
		{ name: "a.bin", kind: "file" as const, suggestedName: "a (副本).bin" },
		{ name: ".env", kind: "file" as const, suggestedName: ".env (副本)" },
		{ name: "folder.ext", kind: "directory" as const, suggestedName: "folder.ext (副本)" },
		{ name: "link", kind: "other" as const, symlink: true, suggestedName: "link (副本)" },
	])("renames a conflicting $kind ($name) without replacing the destination", async (entry) => {
		const { store, calls } = fakeStore(({ params }) => {
			if (params.destinationPath === `target/${entry.name}`)
				throw new PierProtocolError("CONFLICT", "exists", { kind: entry.kind });
			return {};
		});
		await pasteWorkspaceEntries(
			store,
			{ ...copied(), entries: [{ path: `src/${entry.name}`, ...entry }] },
			workspace,
			"target",
			async (question) => {
				expect(question.suggestedName).toBe(entry.suggestedName);
				return { choice: "rename", name: question.suggestedName };
			},
		);
		expect(calls.at(-1)?.params).toMatchObject({
			path: `src/${entry.name}`,
			destinationPath: `target/${entry.suggestedName}`,
			overwrite: false,
		});
		expect(transfers.snapshot()[0]?.state).toBe("done");
	});

	it("asks again when the chosen name exists and continues with the remaining files", async () => {
		const { store, calls } = fakeStore(({ params }) => {
			if (["target/a.bin", "target/a (副本).bin"].includes(params.destinationPath as string))
				throw new PierProtocolError("CONFLICT", "exists", { kind: "file" });
			return {};
		});
		const ask = vi.fn(async (question: PasteConflictQuestion) => ({
			choice: "rename" as const,
			name: question.suggestedName,
		}));
		await pasteWorkspaceEntries(
			store,
			{ ...copied(), entries: [...copied().entries, { path: "b.bin", name: "b.bin", kind: "file" }] },
			workspace,
			"target",
			ask,
		);
		expect(ask).toHaveBeenCalledTimes(2);
		expect(ask.mock.calls[1]?.[0]).toMatchObject({
			path: "target/a (副本).bin",
			suggestedName: "a (副本 2).bin",
			error: "此名称已被占用，请使用其他名称",
		});
		expect(calls.map((call) => call.params.destinationPath)).toEqual([
			"target/a.bin",
			"target/a (副本).bin",
			"target/a (副本 2).bin",
			"target/b.bin",
		]);
		expect(transfers.snapshot().map((transfer) => transfer.state)).toEqual(["done", "done"]);
	});

	it("rejects invalid names before retrying and keeps cancelled moves in the clipboard", async () => {
		const { store, calls } = fakeStore(() => {
			throw new PierProtocolError("CONFLICT", "exists", { kind: "file" });
		});
		setWorkspaceClipboard("move", "source", [...copied().entries, { path: "b.bin", name: "b.bin", kind: "file" }]);
		const clipboard = getWorkspaceClipboard() as WorkspaceClipboardState;
		const ask = vi
			.fn<(question: unknown) => Promise<{ choice: "rename"; name: string } | { choice: "cancel" }>>()
			.mockResolvedValueOnce({ choice: "rename", name: "../escape.bin" })
			.mockResolvedValueOnce({ choice: "rename", name: "a.bin" })
			.mockResolvedValueOnce({ choice: "cancel" });
		await pasteWorkspaceEntries(store, clipboard, workspace, "target", ask);
		expect(ask.mock.calls[1]?.[0]).toMatchObject({ error: "名称不能包含路径分隔符或控制字符" });
		expect(ask.mock.calls[2]?.[0]).toMatchObject({ error: "此名称已被占用，请使用其他名称" });
		expect(calls).toHaveLength(1);
		expect(getWorkspaceClipboard()).toBe(clipboard);
		expect(transfers.snapshot().map((transfer) => transfer.state)).toEqual(["cancelled", "cancelled"]);
		expect(store.closeMovedFilePreview).not.toHaveBeenCalled();
	});

	it("renames a cross-Host move before uploading and deletes only the original source", async () => {
		const { store, calls } = fakeStore(({ method, params }) => {
			if (method === "workspace.readBytes") return { size: 3, modifiedAt: "t1", data: "YWJj", eof: true };
			if (method === "workspace.uploadStart") {
				if (params.path === "target/a.bin") throw new PierProtocolError("CONFLICT", "exists", { kind: "file" });
				return { uploadId: "u", chunkBytes: TRANSFER_CHUNK_BYTES };
			}
			if (method === "workspace.uploadChunk") return { received: 3 };
			return {};
		});
		store.nodeOf = (id) => (id === "source" ? "remote" : "local");
		setWorkspaceClipboard("move", "source", copied().entries);
		await pasteWorkspaceEntries(
			store,
			getWorkspaceClipboard() as WorkspaceClipboardState,
			workspace,
			"target",
			async () => ({ choice: "rename", name: "renamed.bin" }),
		);
		expect(calls.filter((call) => call.method === "workspace.uploadStart").map((call) => call.params.path)).toEqual([
			"target/a.bin",
			"target/renamed.bin",
		]);
		expect(calls.filter((call) => call.method === "workspace.uploadChunk")).toHaveLength(1);
		expect(calls.slice(-2).map((call) => call.method)).toEqual(["workspace.uploadFinish", "workspace.deletePath"]);
		expect(calls.at(-1)?.params.path).toBe("src/a.bin");
		expect(getWorkspaceClipboard()).toBeUndefined();
		expect(transfers.snapshot()[0]).toMatchObject({ name: "renamed.bin", path: "target/renamed.bin", state: "done" });
	});

	it("leaves descendant-directory errors outside the name-conflict flow", async () => {
		const { store } = fakeStore(() => {
			throw new PierProtocolError("BAD_REQUEST", "Cannot transfer a directory into itself or its descendants");
		});
		const ask = vi.fn(async () => ({ choice: "cancel" as const }));
		await pasteWorkspaceEntries(store, copied(), workspace, "target", ask);
		expect(ask).not.toHaveBeenCalled();
		expect(transfers.snapshot()[0]).toMatchObject({
			state: "error",
			error: "不能把文件夹粘贴到它自己或其子文件夹中",
		});
	});

	it("moves dragged files within the workspace and preserves an existing file clipboard", async () => {
		const { store, calls } = fakeStore(() => ({}));
		setWorkspaceClipboard("copy", "source", copied().entries);
		const clipboard = getWorkspaceClipboard();
		await pasteWorkspaceEntries(
			store,
			{ mode: "move", sourceWorkspaceId: "w1", entries: [{ path: "notes.txt", name: "notes.txt", kind: "file" }] },
			workspace,
			"target",
			async () => ({ choice: "cancel" }),
		);
		expect(calls).toEqual([
			{
				method: "workspace.transferPath",
				params: {
					workspaceId: "w1",
					path: "notes.txt",
					destinationWorkspaceId: "w1",
					destinationPath: "target/notes.txt",
					mode: "move",
					overwrite: false,
				},
			},
		]);
		expect(getWorkspaceClipboard()).toBe(clipboard);
		expect(store.closeMovedFilePreview).toHaveBeenCalledWith("w1", "notes.txt");
		expect(store.bumpFiles).toHaveBeenCalledWith("w1");
	});

	it("rejects a drag move on an older Host before dispatching any requests", async () => {
		const { store, calls } = fakeStore(() => ({}));
		store.requireNativeFileTransfers = () => {
			throw new Error("Host needs an update");
		};
		await pasteWorkspaceEntries(
			store,
			{ ...copied("move"), sourceWorkspaceId: "w1" },
			workspace,
			"target",
			async () => ({ choice: "cancel" }),
		);
		expect(calls).toEqual([]);
		expect(store.toast).toHaveBeenCalledWith("error", "Host needs an update");
	});

	it("copies a folder with a native Host operation, without downloading it to the client", async () => {
		const { store, calls } = fakeStore(() => ({ sourcePath: "folder", path: "target/folder", kind: "directory" }));
		await pasteWorkspaceEntries(
			store,
			{ ...copied(), entries: [{ path: "folder", name: "folder", kind: "directory" }] },
			workspace,
			"target",
			async () => ({ choice: "cancel" }),
		);
		expect(calls).toEqual([
			{
				method: "workspace.transferPath",
				params: {
					workspaceId: "source",
					path: "folder",
					destinationWorkspaceId: "w1",
					destinationPath: "target/folder",
					mode: "copy",
					overwrite: false,
				},
			},
		]);
		expect(store.bumpFiles).toHaveBeenCalledWith("source");
		expect(store.bumpFiles).toHaveBeenCalledWith("w1");
	});

	it("asks before replacing files and keeps skipped moves in the clipboard", async () => {
		const { store, calls } = fakeStore(({ params }) => {
			if (!params.overwrite) throw new PierProtocolError("CONFLICT", "exists", { kind: "file" });
			return {};
		});
		setWorkspaceClipboard("move", "source", copied().entries);
		const clipboard = getWorkspaceClipboard() as WorkspaceClipboardState;
		await pasteWorkspaceEntries(store, clipboard, workspace, "", async () => ({ choice: "skip" }));
		expect(calls).toHaveLength(1);
		expect(getWorkspaceClipboard()).toBe(clipboard);
		await pasteWorkspaceEntries(store, clipboard, workspace, "", async (question) => {
			expect(question.canOverwrite).toBe(true);
			return { choice: "overwrite" };
		});
		expect(calls.at(-1)?.params.overwrite).toBe(true);
		expect(getWorkspaceClipboard()).toBeUndefined();
	});

	it("never replaces existing directories", async () => {
		const { store, calls } = fakeStore(() => {
			throw new PierProtocolError("CONFLICT", "exists", { kind: "directory" });
		});
		await pasteWorkspaceEntries(store, copied(), workspace, "", async (question) => {
			expect(question.canOverwrite).toBe(false);
			return { choice: "skip" };
		});
		expect(calls).toHaveLength(1);
	});

	it("streams a cross-Host file and deletes its guarded source only after the destination is committed", async () => {
		const { store, calls } = fakeStore(({ method, params }) => {
			if (method === "workspace.readBytes")
				return { size: 5, modifiedAt: "t1", data: params.offset ? "AP8=" : "YWJj", eof: Boolean(params.offset) };
			if (method === "workspace.uploadStart") return { uploadId: "u", chunkBytes: 4 * 1024 * 1024 };
			if (method === "workspace.uploadChunk")
				return { received: (params.offset as number) + Buffer.from(params.data as string, "base64").length };
			return {};
		});
		store.nodeOf = (id) => (id === "source" ? "remote" : "local");
		await pasteWorkspaceEntries(store, copied("move"), workspace, "target", async () => ({ choice: "cancel" }));
		expect(calls.filter((call) => call.method === "workspace.uploadChunk").map((call) => call.params.data)).toEqual([
			"YWJj",
			"AP8=",
		]);
		expect(calls.slice(-2).map((call) => call.method)).toEqual(["workspace.uploadFinish", "workspace.deletePath"]);
		expect(calls.at(-1)?.params).toEqual({
			workspaceId: "source",
			path: "src/a.bin",
			expectedModifiedAt: "t1",
			expectedSize: 5,
		});
	});

	it("cancels an unfinished destination and retains a source changed while transferring", async () => {
		const { store, calls } = fakeStore(({ method, params }) => {
			if (method === "workspace.readBytes")
				return { size: 5, modifiedAt: params.offset ? "t2" : "t1", data: "YWJj", eof: Boolean(params.offset) };
			if (method === "workspace.uploadStart") return { uploadId: "u", chunkBytes: 4 * 1024 * 1024 };
			if (method === "workspace.uploadChunk") return { received: 3 };
			return {};
		});
		store.nodeOf = (id) => (id === "source" ? "remote" : "local");
		await pasteWorkspaceEntries(store, copied("move"), workspace, "", async () => ({ choice: "cancel" }));
		expect(calls.at(-1)?.method).toBe("workspace.uploadCancel");
		expect(
			calls.some((call) => call.method === "workspace.uploadFinish" || call.method === "workspace.deletePath"),
		).toBe(false);
		expect(transfers.snapshot().at(-1)?.state).toBe("error");
	});

	it("rejects cross-Host folder moves before making changes", async () => {
		const { store, calls } = fakeStore(() => ({}));
		store.nodeOf = (id) => (id === "source" ? "remote" : "local");
		await pasteWorkspaceEntries(
			store,
			{ ...copied("move"), entries: [{ path: "folder", name: "folder", kind: "directory" }] },
			workspace,
			"",
			async () => ({ choice: "cancel" }),
		);
		expect(calls).toEqual([]);
		expect(store.toast).toHaveBeenCalledWith("error", expect.stringContaining("跨电脑暂只支持普通文件"));
	});
});

describe("pasteNameError", () => {
	it.each(["", " ", ".", "..", "../escape", "dir/file", "dir\\file", "C:drive", "bad\u0000name", "bad\nname", "a.bin"])(
		"rejects invalid or unchanged names (%j)",
		(name) => expect(pasteNameError(name, "a.bin")).toBeDefined(),
	);
	it.each(["a (副本).bin", ".env", "folder.ext", " notes.txt "])("accepts a new basename (%s)", (name) => {
		expect(pasteNameError(name, "a.bin")).toBeUndefined();
	});
});
