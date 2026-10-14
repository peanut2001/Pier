import type { WorkspaceFileEntry } from "@pier/protocol";
import { useSyncExternalStore } from "react";

export type WorkspaceClipboardMode = "copy" | "move";

export interface WorkspaceClipboardEntry {
	path: string;
	name: string;
	kind: Extract<WorkspaceFileEntry["kind"], "file" | "directory">;
	symlink?: boolean;
}

export interface WorkspaceClipboardState {
	mode: WorkspaceClipboardMode;
	sourceWorkspaceId: string;
	entries: WorkspaceClipboardEntry[];
}

let current: WorkspaceClipboardState | undefined;
let pasting = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function getWorkspaceClipboard(): WorkspaceClipboardState | undefined {
	return current;
}

export function setWorkspaceClipboard(
	mode: WorkspaceClipboardMode,
	sourceWorkspaceId: string,
	entries: WorkspaceClipboardEntry[],
): void {
	current = entries.length ? { mode, sourceWorkspaceId, entries: entries.map((entry) => ({ ...entry })) } : undefined;
	emit();
}

export function clearWorkspaceClipboard(): void {
	if (!current) return;
	current = undefined;
	emit();
}

/** Keep copied/cut entries pointing at their renamed root or descendant. */
export function renameWorkspaceClipboardPath(workspaceId: string, from: string, to: string): void {
	if (current?.sourceWorkspaceId !== workspaceId) return;
	const entries = current.entries.map((entry) => {
		if (entry.path !== from && !entry.path.startsWith(`${from}/`)) return entry;
		const path = to + entry.path.slice(from.length);
		return { ...entry, path, name: path.slice(path.lastIndexOf("/") + 1) };
	});
	if (entries.every((entry, index) => entry === current?.entries[index])) return;
	current = { ...current, entries };
	emit();
}

export function subscribeWorkspaceClipboard(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function beginWorkspacePaste(): boolean {
	if (pasting) return false;
	pasting = true;
	emit();
	return true;
}

export function finishWorkspacePaste(): void {
	pasting = false;
	emit();
}

const isPasting = () => pasting;

export function useWorkspacePasteBusy(): boolean {
	return useSyncExternalStore(subscribeWorkspaceClipboard, isPasting, isPasting);
}

/** Remove only successfully moved roots, and leave a newer clipboard untouched. */
export function completeWorkspaceMoves(snapshot: WorkspaceClipboardState, paths: readonly string[]): void {
	if (current !== snapshot || snapshot.mode !== "move" || !paths.length) return;
	const completed = new Set(paths);
	const entries = snapshot.entries.filter((entry) => !completed.has(entry.path));
	current = entries.length ? { ...snapshot, entries } : undefined;
	emit();
}

/** The current file clipboard, shared by all desktop workspace panels. */
export function useWorkspaceClipboard(): WorkspaceClipboardState | undefined {
	return useSyncExternalStore(subscribeWorkspaceClipboard, getWorkspaceClipboard, getWorkspaceClipboard);
}
