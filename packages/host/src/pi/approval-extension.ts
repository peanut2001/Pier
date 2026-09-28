import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ApprovalDetails, ApprovalPolicy, UiResponse } from "@pier/protocol";
import { evaluateToolCall } from "../approval/policy.ts";

export interface ApprovalGate {
	policy(): ApprovalPolicy;
	workspacePath(): string;
	/** Allowance keys granted via "allow for this session". Mutated by the extension. */
	readonly allowances: Set<string>;
	requestApproval(details: ApprovalDetails, signal: AbortSignal | undefined): Promise<UiResponse | undefined>;
}

const MAX_FIELD_CHARS = 4000;

export function truncateInput(input: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		result[key] =
			typeof value === "string" && value.length > MAX_FIELD_CHARS
				? `${value.slice(0, MAX_FIELD_CHARS)}… (${value.length - MAX_FIELD_CHARS} more chars)`
				: value;
	}
	return result;
}

/** Built-in `pier-approval` extension: gates tool calls according to the workspace policy. */
export function createApprovalExtension(gate: ApprovalGate): InlineExtension {
	const factory: ExtensionFactory = (pi) => {
		pi.on("tool_call", async (event, ctx) => {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const verdict = evaluateToolCall(
				{ toolName: event.toolName, input },
				{ policy: gate.policy(), workspacePath: gate.workspacePath(), allowances: gate.allowances },
			);
			if (verdict.action === "allow") return undefined;

			const response = await gate.requestApproval(
				{
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					summary: verdict.summary,
					input: truncateInput(input),
					reason: verdict.reason,
					severity: verdict.severity,
					sessionAllowable: verdict.sessionKey !== undefined,
					...(verdict.sessionScope ? { sessionScope: verdict.sessionScope } : {}),
				},
				ctx.signal,
			);

			if (!response) {
				return { block: true, reason: "The user did not approve this tool call (no answer or timed out)." };
			}
			if (response.decision === "allow_once") return undefined;
			if (response.decision === "allow_session" && verdict.sessionKey) {
				gate.allowances.add(verdict.sessionKey);
				return undefined;
			}
			const reason = response.reason?.trim();
			return { block: true, reason: reason ? `Denied by the user: ${reason}` : "Denied by the user." };
		});
	};
	return { name: "pier-approval", factory };
}
