import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writePrivateFile } from "./config.ts";

const ArchiveFileSchema = z.object({
	version: z.literal(1),
	/** Session id → when it was archived (ISO). pi session ids are unique across workspaces. */
	sessions: z.record(z.string(), z.string()),
});

/**
 * Which sessions are archived, in `~/.pier/archived-sessions.json`. Archiving is Pier's own
 * marker: pi's session files are not changed.
 */
export class SessionArchiveStore {
	private sessions: Map<string, string>;

	constructor(
		private readonly path: string,
		private readonly log: (message: string) => void = () => {},
	) {
		this.sessions = this.load();
	}

	private load(): Map<string, string> {
		if (!existsSync(this.path)) return new Map();
		try {
			const parsed = ArchiveFileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
			if (parsed.success) return new Map(Object.entries(parsed.data.sessions));
			this.log(`ignoring invalid ${this.path}: ${parsed.error.message}`);
		} catch (error) {
			this.log(`ignoring unreadable ${this.path}: ${error instanceof Error ? error.message : error}`);
		}
		return new Map();
	}

	private save(): void {
		const content = { version: 1, sessions: Object.fromEntries(this.sessions) };
		writePrivateFile(this.path, `${JSON.stringify(content, null, 2)}\n`);
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** Mark sessions archived or not. Returns whether anything changed. */
	set(sessionIds: Iterable<string>, archived: boolean): boolean {
		let changed = false;
		const now = new Date().toISOString();
		for (const id of sessionIds) {
			if (archived === this.sessions.has(id)) continue;
			if (archived) this.sessions.set(id, now);
			else this.sessions.delete(id);
			changed = true;
		}
		if (changed) this.save();
		return changed;
	}
}
