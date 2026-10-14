/* biome-ignore-all lint/complexity/useLiteralKeys: Seed store clients and nodes without changing the public API. */
import type { PierClient } from "@pier/client";
import { type HostInfo, PierProtocolError } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../src/lib/bridge.ts";
import { LOCAL_NODE, PierStore } from "../src/lib/store.tsx";

beforeEach(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

function setup(owner: string, version = "1.40", connection: "open" | "closed" = "open") {
	const store = new PierStore({ kind: "browser" } as Bridge);
	const request = vi.fn(async (_method: string, params: { path: string }) => ({
		path: params.path,
		size: 0,
		modifiedAt: "2026-10-13T00:00:00Z",
	}));
	const otherRequest = vi.fn();
	store["clients"].set(owner, { request } as unknown as PierClient);
	store["clients"].set("other", { request: otherRequest } as unknown as PierClient);
	store["patchNode"](owner, { connection, hostInfo: { protocolVersion: version } as HostInfo });
	store["set"]({ node: "other", workspaceNodes: { workspace: owner } });
	return { store, request, otherRequest };
}

describe("workspace file creation", () => {
	it.each([LOCAL_NODE, "peer"])(
		"creates on the owning computer (%s) while another computer is selected",
		async (owner) => {
			const { store, request, otherRequest } = setup(owner);
			await store.createFile("workspace", "notes/new.md");
			await store.createDirectory("workspace", "notes/empty");
			expect(request.mock.calls).toEqual([
				["workspace.createFile", { workspaceId: "workspace", path: "notes/new.md" }],
				["workspace.createDirectory", { workspaceId: "workspace", path: "notes/empty" }],
			]);
			expect(otherRequest).not.toHaveBeenCalled();
			expect(store.getState().filesVersion.workspace).toBe(2);
		},
	);

	it("requires the owning host to support creation and be online", async () => {
		const outdated = setup("peer", "1.39");
		await expect(outdated.store.createFile("workspace", "new.md")).rejects.toThrow("请先更新它");
		await expect(outdated.store.createDirectory("workspace", "new")).rejects.toThrow("请先更新它");
		expect(outdated.request).not.toHaveBeenCalled();
		const offline = setup("peer", "1.40", "closed");
		await expect(offline.store.createFile("workspace", "new.md")).rejects.toThrow("尚未连接");
		expect(offline.request).not.toHaveBeenCalled();
	});

	it("keeps the host's conflict error and does not refresh after a failed creation", async () => {
		const { store, request } = setup("peer");
		request.mockRejectedValue(new PierProtocolError("CONFLICT", "Already exists"));
		await expect(store.createFile("workspace", "existing.md")).rejects.toMatchObject({ code: "CONFLICT" });
		expect(store.getState().filesVersion.workspace).toBeUndefined();
	});
});
