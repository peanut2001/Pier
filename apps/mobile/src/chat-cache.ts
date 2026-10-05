import { type ChatState, cacheableChatState } from "@pier/chat-state";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

/** Session states kept in memory after their live subscription ended. */
const MEMORY_LIMIT = 12;
/** Session states kept on disk, and their total size. */
const DISK_FILES_LIMIT = 60;
const DISK_BYTES_LIMIT = 48 * 1024 * 1024;
/** Bump when the stored shape changes; older files are ignored and pruned. */
const FORMAT = 1;
const WRITE_DELAY_MS = 800;

interface Stored {
	format: number;
	hostId: string;
	state: ChatState;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Sessions seen before, kept on the phone (`<cache>/chats`). Opening one again shows it at once
 * and resumes from it: the computer sends only the events since, or the messages after the
 * part this phone already has, instead of the whole transcript. Losing the cache (the system
 * may clear it) only costs one full download.
 */
export class ChatCache {
	private readonly memory = new Map<string, ChatState>();
	private readonly pending = new Map<string, Stored>();
	/** What was last written per key, to skip unchanged writes. */
	private readonly written = new Map<string, string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly disk = Platform.OS !== "web";

	/** The cached state of a session of `hostId`, if any. */
	get(hostId: string, sessionId: string): ChatState | undefined {
		const key = cacheKey(hostId, sessionId);
		const inMemory = this.memory.get(key) ?? this.pending.get(key)?.state;
		if (inMemory) {
			this.remember(key, inMemory);
			return inMemory;
		}
		if (!this.disk) return undefined;
		try {
			const file = new File(this.dir(), `${key}.json`);
			if (!file.exists) return undefined;
			const stored = JSON.parse(file.textSync()) as Stored;
			if (stored.format !== FORMAT || stored.hostId !== hostId || stored.state?.sessionId !== sessionId)
				return undefined;
			this.written.set(key, signature(stored.state));
			this.remember(key, stored.state);
			return stored.state;
		} catch (error) {
			console.warn(`Pier: reading cached session failed: ${errorText(error)}`);
			return undefined;
		}
	}

	/** Keep a session's current state (written to disk shortly, or at `flush`). */
	put(hostId: string, state: ChatState): void {
		const cacheable = cacheableChatState(state);
		if (!cacheable) return;
		const key = cacheKey(hostId, cacheable.sessionId);
		this.remember(key, cacheable);
		if (!this.disk || this.written.get(key) === signature(cacheable)) return;
		this.pending.set(key, { format: FORMAT, hostId, state: cacheable });
		this.timer ??= setTimeout(() => this.flush(), WRITE_DELAY_MS);
	}

	/** Forget a session (deleted on the computer). */
	remove(hostId: string, sessionId: string): void {
		const key = cacheKey(hostId, sessionId);
		this.memory.delete(key);
		this.pending.delete(key);
		this.written.delete(key);
		if (this.disk) this.deleteQuietly(new File(this.dir(), `${key}.json`));
	}

	/** Forget every session of a computer (it was removed from this phone). */
	removeHost(hostId: string): void {
		const prefix = `${safe(hostId)}~`;
		for (const map of [this.memory, this.pending, this.written]) {
			for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
		}
		if (!this.disk) return;
		try {
			const dir = this.dir();
			if (!dir.exists) return;
			for (const entry of dir.list()) if (entry.name.startsWith(prefix)) this.deleteQuietly(entry);
		} catch {
			// Best effort.
		}
	}

	/** Write pending states now (the app is going to the background). */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.pending.size) return;
		const entries = [...this.pending.entries()];
		this.pending.clear();
		try {
			const dir = this.dir();
			if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
			for (const [key, stored] of entries) {
				const file = new File(dir, `${key}.json`);
				file.write(JSON.stringify(stored));
				this.written.set(key, signature(stored.state));
			}
			this.prune(dir);
		} catch (error) {
			console.warn(`Pier: caching sessions failed: ${errorText(error)}`);
		}
	}

	private remember(key: string, state: ChatState): void {
		this.memory.delete(key);
		this.memory.set(key, state);
		while (this.memory.size > MEMORY_LIMIT) {
			const oldest = this.memory.keys().next().value;
			if (oldest === undefined) break;
			this.memory.delete(oldest);
		}
	}

	/** Drop the least recently written files beyond the count and size limits. */
	private prune(dir: Directory): void {
		const files = dir
			.list()
			.filter((entry): entry is File => entry instanceof File)
			.map((file) => ({ file, size: file.size, time: file.modificationTime ?? 0 }))
			.sort((a, b) => b.time - a.time);
		let total = 0;
		files.forEach((entry, index) => {
			total += entry.size;
			if (index >= DISK_FILES_LIMIT || total > DISK_BYTES_LIMIT) {
				this.written.delete(entry.file.name.replace(/\.json$/, ""));
				this.deleteQuietly(entry.file);
			}
		});
	}

	private dir(): Directory {
		return new Directory(Paths.cache, "chats");
	}

	private deleteQuietly(entry: File | Directory): void {
		try {
			if (entry.exists) entry.delete();
		} catch {
			// Replaced or pruned later.
		}
	}
}

/** File-name-safe key of a session of a computer. */
function cacheKey(hostId: string, sessionId: string): string {
	return `${safe(hostId)}~${safe(sessionId)}`;
}

function safe(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Cheap identity of a state's progress: unchanged when nothing new arrived. */
function signature(state: ChatState): string {
	return `${state.epoch ?? ""}:${state.seq}:${state.messages.length}`;
}
