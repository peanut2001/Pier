import { POLICY_LABEL, relativeTime, sessionTitle } from "../lib/format.ts";
import { useAppState, useStore } from "../lib/store.tsx";
import { useAddWorkspace } from "./Sidebar.tsx";

export function Welcome() {
	const addWorkspace = useAddWorkspace();
	const hostInfo = useAppState((s) => s.hostInfo);
	return (
		<div className="home">
			<h1>欢迎使用 Pier</h1>
			<p>
				Pier 在桌面上运行 pi Agent：它能在你指定的项目目录里读写文件、运行命令。关闭窗口后 Agent
				会继续在后台运行，之后也可以从手机连接。
			</p>
			<ol>
				<li>添加一个项目目录作为工作区；</li>
				<li>新建会话，描述你的任务；</li>
				<li>需要执行命令或修改工作区外的文件时，Pier 会请你批准。</li>
			</ol>
			<button type="button" className="primary large" onClick={() => void addWorkspace()}>
				添加工作区
			</button>
			{hostInfo ? (
				<p className="muted small">
					模型与凭据复用 pi 的配置（{hostInfo.agentDir}）。如果还没有可用模型，请先在终端运行 <code>pi</code> 完成登录。
				</p>
			) : null}
		</div>
	);
}

export function WorkspaceHome({ workspaceId }: { workspaceId: string }) {
	const store = useStore();
	const workspace = useAppState((s) => s.workspaces).find((w) => w.id === workspaceId);
	const sessions = useAppState((s) => s.sessions[workspaceId]);
	if (!workspace) return null;
	return (
		<div className="home">
			<h1>{workspace.name}</h1>
			<p className="muted">
				<code>{workspace.path}</code> · 审批策略：{POLICY_LABEL[workspace.policy]}
			</p>
			<button type="button" className="primary large" onClick={() => void store.createSession(workspace.id)}>
				新建会话
			</button>
			{sessions?.length ? (
				<div className="recent">
					<h3>最近的会话</h3>
					{sessions.slice(0, 10).map((session) => (
						<button type="button" key={session.id} className="recent-row" onClick={() => store.selectSession(session)}>
							<span>{sessionTitle(session)}</span>
							<span className="muted">
								{session.messageCount} 条消息 · {relativeTime(session.modifiedAt)}
							</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
