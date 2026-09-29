// Live check: drive the real Claude Code CLI through a Pier host (not part of the test suite).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscript, initialChatState, reduceChat } from "@pier/chat-state";
import { PierClient } from "@pier/client";
import { startLocalGateway } from "../src/gateway/local-gateway.ts";
import { PierHost } from "../src/host.ts";

const runtime = process.argv[2] ?? "claude-code";
const root = mkdtempSync(join(tmpdir(), "pier-live-"));
const work = join(root, "work");
mkdirSync(work);
writeFileSync(join(work, "hello.txt"), "hello world\n");
const token = "live-token-0123456789abcdef";
const host = await PierHost.create({
	pierDir: join(root, "pier"),
	localToken: token,
	env: { agentDir: join(root, "agent") },
	log: (m) => console.error(`[host] ${m}`),
});
const gateway = await startLocalGateway(host);
const client = new PierClient({ url: gateway.url, token, client: { name: "live", version: "0" } });
await client.connect();
console.log(
	"runtimes",
	JSON.stringify((await client.request("runtime.list", {})).runtimes.map((r) => [r.id, r.available, r.version])),
);
const { workspace } = await client.request("workspace.add", { path: work });
const models = await client.request("model.list", { workspaceId: workspace.id, runtime });
console.log("models", models.models.map((m) => m.id).join(", "), "current", models.current?.id, models.thinkingLevel);
const { session } = await client.request("session.create", { workspaceId: workspace.id, runtime });
if (process.argv[3])
	await client.request("model.set", { sessionId: session.id, provider: runtime, modelId: process.argv[3] });
let state = initialChatState(session.id, session);
let settled: () => void = () => {};
await client.subscribe(
	session.id,
	(frame) => {
		state = reduceChat(state, frame);
		const e = frame.event;
		if (e.type === "ui.request") {
			const r = e.request as { id: string; kind: string; approval?: { toolName: string; summary: string } };
			console.log("UI REQUEST", r.kind, r.approval?.toolName, r.approval?.summary);
			void client.request("ui.respond", {
				sessionId: session.id,
				requestId: r.id,
				response: { decision: "allow_once" },
			});
		}
		if (e.type === "agent_settled") settled();
	},
	{ workspaceId: workspace.id },
);
const run = async (text: string) => {
	const done = new Promise<void>((r) => {
		settled = r;
	});
	await client.request("session.prompt", { sessionId: session.id, text });
	await done;
};
await run(
	"Run `ls` with Bash, then change 'world' to 'pier' in hello.txt with the Edit tool, then run `git init -q && touch x.txt` with Bash. Be brief.",
);
for (const item of buildTranscript(state)) {
	if (item.kind === "user") console.log("USER:", item.text);
	else if (item.kind === "assistant") {
		for (const b of item.blocks) {
			if (b.kind === "text") console.log("  TEXT:", b.text);
			else if (b.kind === "thinking") console.log("  THINK:", b.text.slice(0, 60));
			else
				console.log(
					"  TOOL:",
					b.call.name,
					JSON.stringify(b.call.arguments).slice(0, 100),
					b.status,
					JSON.stringify(b.result?.details ?? "").slice(0, 80),
				);
		}
	}
}
const snapshot = await client.request("session.snapshot", { sessionId: session.id });
console.log("error:", state.errorMessage);
console.log("snapshot matches live:", JSON.stringify(snapshot.messages) === JSON.stringify(state.messages));
await client.request("session.rename", { sessionId: session.id, name: "Pier live check" });
await client.request("session.close", { sessionId: session.id });
const listed = (await client.request("session.list", { workspaceId: workspace.id })).sessions;
console.log(
	"listed",
	JSON.stringify(listed.map((s) => [s.runtime, s.name, s.messageCount, s.firstMessage.slice(0, 30)])),
);
await client.request("session.open", { workspaceId: workspace.id, sessionId: session.id });
const reopened = await client.request("session.snapshot", { sessionId: session.id });
console.log("reopened roles", reopened.messages.map((m) => (m as { role: string }).role).join(","));
const points = await client.request("session.forkPoints", { sessionId: session.id });
console.log("fork points", points.points.length);
client.close();
await host.shutdown();
await gateway.close();
console.log("root", root);
