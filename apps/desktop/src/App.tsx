import { useState } from "react";
import { Welcome, WorkspaceHome } from "./components/Home.tsx";
import { HostBanner, LogsPanel } from "./components/HostPanels.tsx";
import { PairingRequestDialog, RemotePanel } from "./components/RemotePanel.tsx";
import { SessionView } from "./components/SessionView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { useAppState, useStore } from "./lib/store.tsx";

function Toasts() {
	const store = useStore();
	const toasts = useAppState((s) => s.toasts);
	if (!toasts.length) return null;
	return (
		<div className="toasts">
			{toasts.map((toast) => (
				<div key={toast.id} className={`toast ${toast.level}`}>
					<span>{toast.message}</span>
					<button type="button" className="ghost icon" onClick={() => store.dismissToast(toast.id)}>
						×
					</button>
				</div>
			))}
		</div>
	);
}

function Main() {
	const store = useStore();
	const selectedSessionId = useAppState((s) => s.selectedSessionId);
	const selectedWorkspaceId = useAppState((s) => s.selectedWorkspaceId);
	const workspaces = useAppState((s) => s.workspaces);
	const workspacesLoaded = useAppState((s) => s.workspacesLoaded);
	useAppState((s) => s.sessions);
	const session = store.findSession(selectedSessionId);

	if (session) return <SessionView key={session.id} session={session} />;
	if (!workspacesLoaded) return <div className="placeholder center" />;
	if (!workspaces.length) return <Welcome />;
	if (selectedWorkspaceId) return <WorkspaceHome workspaceId={selectedWorkspaceId} />;
	return <div className="placeholder center">选择左侧的工作区或会话</div>;
}

export function App() {
	const [showLogs, setShowLogs] = useState(false);
	const [showRemote, setShowRemote] = useState(false);
	return (
		<div className="app">
			<Sidebar onShowLogs={() => setShowLogs(true)} onShowRemote={() => setShowRemote(true)} />
			<main className="main">
				<HostBanner onShowLogs={() => setShowLogs(true)} />
				<Main />
			</main>
			<Toasts />
			{showLogs ? <LogsPanel onClose={() => setShowLogs(false)} /> : null}
			{showRemote ? <RemotePanel onClose={() => setShowRemote(false)} /> : null}
			<PairingRequestDialog />
		</div>
	);
}
