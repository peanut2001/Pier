import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	bytesToBase64,
	downloadFile,
	type OverwriteAnswer,
	TRANSFER_CHUNK_BYTES,
	transfers,
	uploadFiles,
	uploadItemsFromInput,
} from "../src/lib/file-transfers.ts";
import type { PierStore } from "../src/lib/store.tsx";

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
		expect(transfers.snapshot()[0]).toMatchObject({ name: "f.txt", state: "done", done: 11, savedTo: "/local/out.bin" });

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
