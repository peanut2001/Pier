import type { UiRequest, UiResponse } from "@pier/protocol";
import { useEffect, useState } from "react";
import { IconCheck, IconClock, IconInfo, IconShieldAlert, IconX } from "./Icons.tsx";

function useCountdown(expiresAt: string | undefined): string | undefined {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!expiresAt) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [expiresAt]);
	if (!expiresAt) return undefined;
	const left = Math.max(0, Date.parse(expiresAt) - now);
	if (left > 10 * 60_000) return undefined;
	const minutes = Math.floor(left / 60_000);
	const seconds = Math.floor((left % 60_000) / 1000);
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ApprovalCard({ request, respond }: { request: UiRequest; respond: (r: UiResponse) => void }) {
	const approval = request.approval;
	const [denying, setDenying] = useState(false);
	const [reason, setReason] = useState("");
	const countdown = useCountdown(request.expiresAt);
	if (!approval) return null;
	const high = approval.severity === "high";
	return (
		<div className={`ui-card approval${high ? " high" : ""}`}>
			<div className="ui-card-title">
				<span className="ui-card-icon">
					<IconShieldAlert size={16} />
				</span>
				<span className="ui-card-heading">
					<span className="ui-card-heading-main">
						Agent 请求执行 <span className="tool-name">{approval.toolName}</span>
					</span>
					<span className={`severity ${approval.severity}`}>{high ? "高风险" : "需要批准"}</span>
				</span>
				{countdown ? (
					<span className="countdown">
						<IconClock size={12} />
						{countdown} 后自动拒绝
					</span>
				) : null}
			</div>
			<pre className="approval-summary">{approval.summary}</pre>
			<div className="ui-card-reason">{approval.reason}</div>
			{denying ? (
				<form
					className="deny-form"
					onSubmit={(event) => {
						event.preventDefault();
						respond({ decision: "deny", ...(reason.trim() ? { reason: reason.trim() } : {}) });
					}}
				>
					<input
						// biome-ignore lint/a11y/noAutofocus: the user just chose to deny and is typing a reason.
						autoFocus
						placeholder="拒绝理由（会告诉 Agent，可留空）"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") setDenying(false);
						}}
					/>
					<button type="submit" className="danger">
						确认拒绝
					</button>
					<button type="button" onClick={() => setDenying(false)}>
						返回
					</button>
				</form>
			) : (
				<div className="ui-card-actions">
					<button type="button" className="primary" onClick={() => respond({ decision: "allow_once" })}>
						<IconCheck size={15} />
						允许一次
					</button>
					{approval.sessionAllowable ? (
						<button
							type="button"
							onClick={() => respond({ decision: "allow_session" })}
							title={approval.sessionScope ?? ""}
						>
							<span className="button-text">
								本会话内允许{approval.sessionScope ? `：${approval.sessionScope}` : ""}
							</span>
						</button>
					) : null}
					<button type="button" className="danger" onClick={() => setDenying(true)}>
						<IconX size={15} />
						拒绝…
					</button>
				</div>
			)}
		</div>
	);
}

function DialogCard({ request, respond }: { request: UiRequest; respond: (r: UiResponse) => void }) {
	const [value, setValue] = useState(request.prefill ?? "");
	const countdown = useCountdown(request.expiresAt);
	return (
		<div className="ui-card">
			<div className="ui-card-title">
				<span className="ui-card-icon info">
					<IconInfo size={16} />
				</span>
				<span className="severity normal">
					{request.kind === "confirm" ? "确认" : request.kind === "select" ? "选择" : "输入"}
				</span>
				<span>{request.title}</span>
				{countdown ? (
					<span className="countdown">
						<IconClock size={12} />
						{countdown} 后超时
					</span>
				) : null}
			</div>
			{request.message ? <div className="ui-card-message">{request.message}</div> : null}
			{request.kind === "confirm" ? (
				<div className="ui-card-actions">
					<button type="button" className="primary" onClick={() => respond({ confirmed: true })}>
						是
					</button>
					<button type="button" onClick={() => respond({ confirmed: false })}>
						否
					</button>
				</div>
			) : request.kind === "select" ? (
				<div className="ui-card-options">
					{(request.options ?? []).map((option) => (
						<button type="button" key={option} onClick={() => respond({ value: option })}>
							{option}
						</button>
					))}
					<button type="button" className="ghost" onClick={() => respond({ cancelled: true })}>
						取消
					</button>
				</div>
			) : (
				<form
					className="ui-card-input"
					onSubmit={(event) => {
						event.preventDefault();
						respond({ value });
					}}
				>
					{request.kind === "editor" ? (
						<textarea rows={6} value={value} onChange={(e) => setValue(e.target.value)} />
					) : (
						<input value={value} placeholder={request.placeholder ?? ""} onChange={(e) => setValue(e.target.value)} />
					)}
					<div className="ui-card-actions">
						<button type="submit" className="primary">
							提交
						</button>
						<button type="button" onClick={() => respond({ cancelled: true })}>
							取消
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

export function PendingRequests({
	requests,
	respond,
}: {
	requests: UiRequest[];
	respond: (requestId: string, response: UiResponse) => void;
}) {
	if (!requests.length) return null;
	return (
		<div className="pending-requests">
			{requests.map((request) =>
				request.kind === "approval" ? (
					<ApprovalCard key={request.id} request={request} respond={(r) => respond(request.id, r)} />
				) : (
					<DialogCard key={request.id} request={request} respond={(r) => respond(request.id, r)} />
				),
			)}
		</div>
	);
}
