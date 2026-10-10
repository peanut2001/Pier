import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PierClient } from "@pier/client";
import type { ScheduledTaskInput, WorkspaceInfo } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClaude } from "./fake-claude.ts";
import { fauxAssistantMessage, fauxToolCall, startTestHost, type TestHost } from "./helpers.ts";

describe("scheduled task protocol and agent execution", () => {
	let t: TestHost;
	let client: PierClient;
	let workspace: WorkspaceInfo;
	let agentsDir: string;
	let input: ScheduledTaskInput;
	beforeEach(async () => {
		agentsDir = mkdtempSync(join(tmpdir(), "pier-task-agents-"));
		const fake = new FakeClaude(agentsDir);
		t = await startTestHost({
			agents: {
				claudeCode: {
					executable: process.execPath,
					configDir: agentsDir,
					sdk: fake.sdk,
					catalog: {
						commands: [],
						models: [{ provider: "claude-code", id: "default", name: "Default", reasoning: true, input: ["text"] }],
					},
				},
				codex: {
					executable: process.execPath,
					args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs")],
					env: { ...process.env, FAKE_CODEX_DIR: agentsDir },
				},
			},
		});
		client = await t.connect();
		workspace = (await client.request("workspace.add", { path: t.workspaceDir })).workspace;
		input = {
			name: "daily report",
			prompt: "hello",
			workspaceId: workspace.id,
			runtime: "pi",
			schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
		};
	});
	afterEach(async () => {
		await t.close();
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it.each(["pi", "claude-code", "codex"])(
		"runs %s in a fresh persisted session and opens the result",
		async (runtime) => {
			t.faux.setResponses([fauxAssistantMessage("scheduled report")]);
			const { task } = await client.request("task.create", { ...input, runtime });
			const { run } = await client.request("task.run", { taskId: task.id });
			await vi.waitFor(async () =>
				expect((await client.request("task.runs", { taskId: task.id })).runs[0]?.status).toBe("succeeded"),
			);
			const finished = (await client.request("task.runs")).runs.find((r) => r.id === run.id);
			expect(finished?.summary).toBeTruthy();
			expect(finished?.sessionId).toBeTruthy();
			const { session } = await client.request("session.open", {
				workspaceId: workspace.id,
				sessionId: finished?.sessionId ?? "",
			});
			expect(session.runtime).toBe(runtime);
			expect(session.name).toContain("daily report");
			expect((await client.request("task.readRun", { runId: run.id })).run.read).toBe(true);
			expect((await client.request("task.list")).tasks[0]?.nextRunAt).toBe(task.nextRunAt);
		},
	);

	it("sends the explicit model and thinking level without changing defaults", async () => {
		t.faux.setResponses([fauxAssistantMessage("ok")]);
		const { task } = await client.request("task.create", {
			...input,
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "high",
		});
		await client.request("task.run", { taskId: task.id });
		await vi.waitFor(async () => expect((await client.request("task.runs")).runs[0]?.status).toBe("succeeded"));
		const run = (await client.request("task.runs")).runs[0];
		const snapshot = await client.request("session.snapshot", { sessionId: run?.sessionId ?? "" });
		expect(snapshot.model?.id).toBe("faux-1");
		expect(snapshot.thinkingLevel).toBe("high");
		expect((await client.request("model.list", { workspaceId: workspace.id })).thinkingLevel).not.toBe("high");
	});

	it("runs a once schedule automatically even with no connected client", async () => {
		t.faux.setResponses([fauxAssistantMessage("automatic report")]);
		const { task } = await client.request("task.create", {
			...input,
			schedule: { kind: "once", at: new Date(Date.now() + 100).toISOString() },
		});
		client.close();
		await vi.waitFor(() => {
			t.host.tasks.tick();
			expect(t.host.tasks.runs(task.id)[0]?.status).toBe("succeeded");
		});
		expect(t.host.tasks.list()[0]?.status).toBe("completed");
		expect(t.host.tasks.runs(task.id)).toHaveLength(1);
	});

	it("preserves the workspace approval policy and stops a waiting run", async () => {
		await client.request("workspace.setPolicy", { workspaceId: workspace.id, policy: "ask" });
		t.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "report.txt", content: "test" })], { stopReason: "toolUse" }),
		]);
		const { task } = await client.request("task.create", input);
		await client.request("task.run", { taskId: task.id });
		await vi.waitFor(async () => expect((await client.request("task.runs")).runs[0]?.status).toBe("waiting"));
		expect((await client.request("task.stop", { taskId: task.id })).stopped).toBe(true);
		expect((await client.request("task.runs")).runs[0]?.status).toBe("interrupted");
		expect(t.host.config.getWorkspace(workspace.id)?.policy).toBe("ask");
	});

	it("rejects missing workspaces and invalid schedules, and pauses tasks when removing a workspace", async () => {
		await expect(client.request("task.create", { ...input, workspaceId: "missing" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			client.request("task.create", { ...input, schedule: { kind: "interval", minutes: 0 } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const { task } = await client.request("task.create", input);
		await client.request("task.setStatus", { taskId: task.id, status: "paused" });
		await client.request("task.update", { taskId: task.id, task: { ...input, name: "updated" } });
		expect((await client.request("task.list")).tasks[0]).toMatchObject({ name: "updated", status: "paused" });
		await client.request("task.setStatus", { taskId: task.id, status: "active" });
		await client.request("workspace.remove", { workspaceId: workspace.id });
		expect((await client.request("task.list")).tasks[0]?.status).toBe("paused");
		await client.request("task.delete", { taskId: task.id });
		expect((await client.request("task.list")).tasks).toEqual([]);
	});
});
