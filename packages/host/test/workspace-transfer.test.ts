import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_READ_BYTES, readWorkspaceBytes } from "../src/workspace-files.ts";
import { MAX_UPLOAD_CHUNK_BYTES, WorkspaceUploads } from "../src/workspace-uploads.ts";
import { startTestHost, type TestHost } from "./helpers.ts";

async function expectCode(promise: Promise<unknown>, code: string): Promise<PierProtocolError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(PierProtocolError);
	expect((error as PierProtocolError).code).toBe(code);
	return error as PierProtocolError;
}

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

describe("readWorkspaceBytes", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-bytes-"));
		outside = mkdtempSync(join(tmpdir(), "pier-bytes-out-"));
		writeFileSync(join(root, "data.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
		mkdirSync(join(root, "dir"));
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("reads ranges and reports the end of the file", async () => {
		const first = await readWorkspaceBytes(root, "data.bin", 0, 4);
		expect(first).toMatchObject({ path: "data.bin", size: 10, offset: 0, eof: false });
		expect([...Buffer.from(first.data, "base64")]).toEqual([0, 1, 2, 3]);
		const last = await readWorkspaceBytes(root, "data.bin", 8, 4);
		expect([...Buffer.from(last.data, "base64")]).toEqual([8, 9]);
		expect(last.eof).toBe(true);
		const past = await readWorkspaceBytes(root, "data.bin", 20, 4);
		expect(past).toMatchObject({ data: "", eof: true });
	});

	it("rejects directories, escapes and bad ranges", async () => {
		await expectCode(readWorkspaceBytes(root, "dir", 0, 1), "BAD_REQUEST");
		await expectCode(readWorkspaceBytes(root, "leak.txt", 0, 1), "FORBIDDEN");
		await expectCode(readWorkspaceBytes(root, "../x", 0, 1), "BAD_REQUEST");
		await expectCode(readWorkspaceBytes(root, "missing", 0, 1), "NOT_FOUND");
		await expectCode(readWorkspaceBytes(root, "data.bin", -1, 1), "BAD_REQUEST");
		await expectCode(readWorkspaceBytes(root, "data.bin", 0, MAX_READ_BYTES + 1), "BAD_REQUEST");
	});
});

describe("WorkspaceUploads", () => {
	let root: string;
	let outside: string;
	let uploads: WorkspaceUploads;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pier-upload-"));
		outside = mkdtempSync(join(tmpdir(), "pier-upload-out-"));
		symlinkSync(outside, join(root, "out"));
		writeFileSync(join(root, "exists.txt"), "old");
		uploads = new WorkspaceUploads();
	});
	afterEach(async () => {
		await uploads.shutdown();
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("uploads a file in chunks into new directories", async () => {
		const { uploadId, path, chunkBytes } = await uploads.start("c1", root, "a\\b/new.txt", 11);
		expect(path).toBe("a/b/new.txt");
		expect(chunkBytes).toBe(MAX_UPLOAD_CHUNK_BYTES);
		expect(existsSync(join(root, "a", "b", "new.txt"))).toBe(false);
		expect(await uploads.chunk("c1", uploadId, 0, b64("hello "))).toEqual({ received: 6 });
		await expectCode(uploads.chunk("c1", uploadId, 0, b64("again")), "CONFLICT");
		expect(await uploads.chunk("c1", uploadId, 6, b64("world"))).toEqual({ received: 11 });
		const result = await uploads.finish("c1", uploadId);
		expect(result).toMatchObject({ path: "a/b/new.txt", size: 11 });
		expect(readFileSync(join(root, "a", "b", "new.txt"), "utf8")).toBe("hello world");
		expect(readdirSync(join(root, "a", "b"))).toEqual(["new.txt"]);
		expect(uploads.count).toBe(0);
	});

	it("uploads empty files", async () => {
		const { uploadId } = await uploads.start("c1", root, "empty", 0);
		expect(await uploads.finish("c1", uploadId)).toMatchObject({ path: "empty", size: 0 });
		expect(readFileSync(join(root, "empty"), "utf8")).toBe("");
	});

	it("replaces existing files only with overwrite", async () => {
		const error = await expectCode(uploads.start("c1", root, "exists.txt", 3), "CONFLICT");
		expect(error.data).toEqual({ kind: "file" });
		const { uploadId } = await uploads.start("c1", root, "exists.txt", 3, true);
		await uploads.chunk("c1", uploadId, 0, b64("new"));
		await uploads.finish("c1", uploadId);
		expect(readFileSync(join(root, "exists.txt"), "utf8")).toBe("new");
	});

	it("refuses to finish when the destination appeared meanwhile", async () => {
		const { uploadId } = await uploads.start("c1", root, "race.txt", 1);
		await uploads.chunk("c1", uploadId, 0, b64("x"));
		writeFileSync(join(root, "race.txt"), "theirs");
		await expectCode(uploads.finish("c1", uploadId), "CONFLICT");
		expect(readFileSync(join(root, "race.txt"), "utf8")).toBe("theirs");
		expect(readdirSync(root).sort()).toEqual(["exists.txt", "out", "race.txt"]);
	});

	it("rejects directories, escapes, oversize data and incomplete uploads", async () => {
		mkdirSync(join(root, "dir"));
		expect((await expectCode(uploads.start("c1", root, "dir", 1, true), "CONFLICT")).data).toEqual({
			kind: "directory",
		});
		await expectCode(uploads.start("c1", root, "exists.txt/x", 1), "BAD_REQUEST");
		await expectCode(uploads.start("c1", root, "out/x.txt", 1), "FORBIDDEN");
		await expectCode(uploads.start("c1", root, "../x.txt", 1), "BAD_REQUEST");
		await expectCode(uploads.start("c1", root, ".", 1), "BAD_REQUEST");
		expect(readdirSync(outside)).toEqual([]);

		const { uploadId } = await uploads.start("c1", root, "short.txt", 2);
		await expectCode(uploads.chunk("c1", uploadId, 0, b64("abc")), "BAD_REQUEST");
		await uploads.chunk("c1", uploadId, 0, b64("a"));
		await expectCode(uploads.finish("c1", uploadId), "BAD_REQUEST");
		// Still usable after a failed finish.
		await uploads.chunk("c1", uploadId, 1, b64("b"));
		await uploads.finish("c1", uploadId);
		expect(readFileSync(join(root, "short.txt"), "utf8")).toBe("ab");
	});

	it("keeps uploads private to their connection and cleans up on cancel and close", async () => {
		const a = await uploads.start("c1", root, "a.txt", 5);
		await uploads.chunk("c1", a.uploadId, 0, b64("ab"));
		await expectCode(uploads.chunk("c2", a.uploadId, 2, b64("c")), "NOT_FOUND");
		expect(await uploads.cancel("c2", a.uploadId)).toEqual({ cancelled: false });
		expect(await uploads.cancel("c1", a.uploadId)).toEqual({ cancelled: true });
		await expectCode(uploads.chunk("c1", a.uploadId, 2, b64("c")), "NOT_FOUND");

		await uploads.start("c1", root, "b.txt", 5);
		uploads.connectionClosed("c1");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(uploads.count).toBe(0);
		expect(readdirSync(root).sort()).toEqual(["exists.txt", "out"]);
	});

	it("expires idle uploads", async () => {
		const idle = new WorkspaceUploads({ idleMs: 20 });
		await idle.start("c1", root, "idle.txt", 5);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(idle.count).toBe(0);
		expect(readdirSync(root).sort()).toEqual(["exists.txt", "out"]);
		await idle.shutdown();
	});
});

describe("workspace transfers over the protocol", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;

	beforeEach(async () => {
		t = await startTestHost();
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
	});
	afterEach(() => t.close());

	it("uploads and downloads a binary file", async () => {
		const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
		const started = await client.request("workspace.uploadStart", {
			workspaceId: workspace.id,
			path: "bin/blob.dat",
			size: bytes.length,
		});
		for (let offset = 0; offset < bytes.length; offset += 1024) {
			await client.request("workspace.uploadChunk", {
				uploadId: started.uploadId,
				offset,
				data: b64(bytes.subarray(offset, offset + 1024)),
			});
		}
		const done = await client.request("workspace.uploadFinish", { uploadId: started.uploadId });
		expect(done).toMatchObject({ path: "bin/blob.dat", size: 3000 });

		const parts: Buffer[] = [];
		for (let offset = 0; ; ) {
			const chunk = await client.request("workspace.readBytes", {
				workspaceId: workspace.id,
				path: "bin/blob.dat",
				offset,
				length: 1000,
			});
			const data = Buffer.from(chunk.data, "base64");
			parts.push(data);
			offset += data.length;
			if (chunk.eof) break;
		}
		expect(Buffer.concat(parts).equals(bytes)).toBe(true);
	});

	it("cancels uploads when the connection closes", async () => {
		await client.request("workspace.uploadStart", { workspaceId: workspace.id, path: "gone.txt", size: 4 });
		expect(readdirSync(t.workspaceDir)).toHaveLength(1);
		await client.close();
		for (let i = 0; i < 50 && readdirSync(t.workspaceDir).length; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(readdirSync(t.workspaceDir)).toEqual([]);
	});
});
