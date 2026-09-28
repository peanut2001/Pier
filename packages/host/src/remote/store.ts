import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import {
	equalBytes,
	fromBase64Url,
	generateKeyPair,
	type KeyPair,
	keyFingerprint,
	keyPairFromSecret,
	toBase64Url,
} from "@pier/crypto";
import type { DeviceInfo } from "@pier/protocol";
import { z } from "zod";
import { writePrivateFile } from "../config.ts";

// ---- host identity ----------------------------------------------------------------------

const IdentitySchema = z.object({
	version: z.literal(1),
	/** X25519 secret key, base64url. */
	secretKey: z.string().min(1),
	createdAt: z.string(),
});

/**
 * Load the host's long-term X25519 key pair from `identity.json` (mode 0600), creating
 * it on first use. Devices pin its public key during pairing.
 */
export function loadOrCreateIdentity(path: string): KeyPair {
	if (existsSync(path)) {
		const parsed = IdentitySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.success) throw new Error(`Invalid Pier identity at ${path}`);
		return keyPairFromSecret(fromBase64Url(parsed.data.secretKey));
	}
	const keyPair = generateKeyPair();
	const record: z.infer<typeof IdentitySchema> = {
		version: 1,
		secretKey: toBase64Url(keyPair.secretKey),
		createdAt: new Date().toISOString(),
	};
	writePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`);
	return keyPair;
}

// ---- paired devices ---------------------------------------------------------------------

const DeviceRecordSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	platform: z.string().optional(),
	model: z.string().optional(),
	appVersion: z.string().optional(),
	/** X25519 static public key, base64url. */
	publicKey: z.string().min(1),
	pairedAt: z.string(),
	lastSeenAt: z.string().optional(),
});
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

const DevicesFileSchema = z.object({ version: z.literal(1), devices: z.array(DeviceRecordSchema) });

/** Only persist `lastSeenAt` changes this often per device. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/** Registered remote devices in `devices.json` (mode 0600). */
export class DeviceStore {
	private devices: DeviceRecord[];
	private readonly lastWrite = new Map<string, number>();

	constructor(private readonly path: string) {
		if (existsSync(path)) {
			const parsed = DevicesFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
			if (!parsed.success) throw new Error(`Invalid Pier device list at ${path}: ${parsed.error.message}`);
			this.devices = parsed.data.devices;
		} else {
			this.devices = [];
		}
	}

	private save(): void {
		writePrivateFile(this.path, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`);
	}

	list(): DeviceRecord[] {
		return this.devices.map((d) => ({ ...d }));
	}

	get(id: string): DeviceRecord | undefined {
		const device = this.devices.find((d) => d.id === id);
		return device ? { ...device } : undefined;
	}

	findByKey(publicKey: Uint8Array): DeviceRecord | undefined {
		const device = this.devices.find((d) => {
			try {
				return equalBytes(fromBase64Url(d.publicKey), publicKey);
			} catch {
				return false;
			}
		});
		return device ? { ...device } : undefined;
	}

	/** Register a device; pairing an already registered key again updates it and keeps its id. */
	register(input: {
		publicKey: Uint8Array;
		name: string;
		platform?: string;
		model?: string;
		appVersion?: string;
	}): DeviceRecord {
		const now = new Date().toISOString();
		const existing = this.findByKey(input.publicKey);
		const record: DeviceRecord = {
			id: existing?.id ?? randomUUID(),
			name: input.name,
			...(input.platform ? { platform: input.platform } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.appVersion ? { appVersion: input.appVersion } : {}),
			publicKey: toBase64Url(input.publicKey),
			pairedAt: now,
			lastSeenAt: now,
		};
		this.devices = [...this.devices.filter((d) => d.id !== record.id), record];
		this.save();
		return { ...record };
	}

	rename(id: string, name: string): DeviceRecord | undefined {
		const device = this.devices.find((d) => d.id === id);
		if (!device) return undefined;
		device.name = name;
		this.save();
		return { ...device };
	}

	remove(id: string): boolean {
		const before = this.devices.length;
		this.devices = this.devices.filter((d) => d.id !== id);
		if (this.devices.length === before) return false;
		this.lastWrite.delete(id);
		this.save();
		return true;
	}

	touch(id: string): void {
		const device = this.devices.find((d) => d.id === id);
		if (!device) return;
		const now = Date.now();
		device.lastSeenAt = new Date(now).toISOString();
		if (now - (this.lastWrite.get(id) ?? 0) < LAST_SEEN_WRITE_INTERVAL_MS) return;
		this.lastWrite.set(id, now);
		this.save();
	}
}

export function toDeviceInfo(record: DeviceRecord, connected: boolean): DeviceInfo {
	let fingerprint = "";
	try {
		fingerprint = keyFingerprint(fromBase64Url(record.publicKey));
	} catch {
		// Leave empty for a corrupt key; the device cannot authenticate anyway.
	}
	return {
		id: record.id,
		name: record.name,
		...(record.platform ? { platform: record.platform } : {}),
		...(record.model ? { model: record.model } : {}),
		...(record.appVersion ? { appVersion: record.appVersion } : {}),
		fingerprint,
		pairedAt: record.pairedAt,
		...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
		connected,
	};
}

// ---- audit log --------------------------------------------------------------------------

export interface AuditEntry {
	event: string;
	deviceId?: string;
	deviceName?: string;
	address?: string;
	sessionId?: string;
	detail?: Record<string, unknown>;
}

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

/**
 * Append-only JSONL log of what remote devices did (connections, pairing, prompts,
 * approvals). Prompt text is not recorded, only its length. Rotates to `.1` at 5 MiB.
 */
export class AuditLog {
	constructor(private readonly path: string) {}

	write(entry: AuditEntry): void {
		try {
			if (existsSync(this.path) && statSync(this.path).size > MAX_AUDIT_BYTES) {
				renameSync(this.path, `${this.path}.1`);
			}
			appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
		} catch {
			// Auditing must never break request handling.
		}
	}
}
