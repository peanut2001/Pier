import { stripTrailingImageHints } from "@pier/chat-state";
import type { ApprovalPolicy, SessionRunState, SessionSummary } from "@pier/protocol";

export function sessionTitle(session: Pick<SessionSummary, "name" | "firstMessage">): string {
	if (session.name) return session.name;
	// Older computers send the first prompt with pi's image notes still attached.
	const raw = session.firstMessage.replace(/\s+/g, " ").trim();
	return stripTrailingImageHints(raw) || (raw ? "图片" : "新会话");
}

export function relativeTime(iso: string | number | undefined): string {
	if (iso === undefined) return "";
	const time = typeof iso === "number" ? iso : Date.parse(iso);
	if (!Number.isFinite(time)) return "";
	const diff = Date.now() - time;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Date(time).toLocaleDateString();
}

export const RUN_STATE_LABEL: Record<SessionRunState, string> = {
	inactive: "未加载",
	idle: "空闲",
	streaming: "运行中",
	compacting: "压缩中",
	retrying: "重试中",
};

export function isBusy(state: SessionRunState): boolean {
	return state === "streaming" || state === "compacting" || state === "retrying";
}

export const POLICY_LABEL: Record<ApprovalPolicy, string> = {
	ask: "逐项审批",
	smart: "智能",
	auto: "自动放行",
};

export const POLICY_DESCRIPTION: Record<ApprovalPolicy, string> = {
	ask: "bash、write、edit 每次都需要你批准。",
	smart: "只读命令与工作区内的文件修改直接放行；其他命令、工作区外写入与危险操作需要批准。",
	auto: "所有工具调用直接执行，不再询问。仅在你完全信任当前任务时使用。",
};

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
