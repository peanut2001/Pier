import type { SessionRunState, SessionSummary } from "@pier/protocol";

export function sessionTitle(session: Pick<SessionSummary, "name" | "firstMessage">): string {
	const text = session.name || session.firstMessage.replace(/\s+/g, " ").trim();
	return text || "新会话";
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

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
