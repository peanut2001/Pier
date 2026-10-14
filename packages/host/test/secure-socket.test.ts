import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { SecureWebSocket, type WebSocketLike } from "@pier/client";
import { generateKeyPair } from "@pier/crypto";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

describe("unfinished secure connections", () => {
	it.each(["cancel", "timeout"] as const)("closes a pending Node WebSocket safely on %s", async (action) => {
		const server = createServer();
		const connections = new Set<Socket>();
		// Leave the upgrade unanswered so the client stays CONNECTING.
		server.on("connection", (socket) => {
			connections.add(socket);
			socket.on("close", () => connections.delete(socket));
		});
		server.on("upgrade", () => {});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		let secure: SecureWebSocket | undefined;
		try {
			let created!: (socket: WebSocket) => void;
			const pending = new Promise<WebSocket>((resolve) => {
				created = resolve;
			});
			secure = new SecureWebSocket({
				addresses: [`127.0.0.1:${(server.address() as AddressInfo).port}`],
				hostPublicKey: generateKeyPair().publicKey,
				deviceKeyPair: generateKeyPair(),
				openTimeoutMs: action === "timeout" ? 25 : 4000,
				createWebSocket: (url) => {
					const socket = new WebSocket(url);
					created(socket);
					return socket as unknown as WebSocketLike;
				},
			});
			const onError = vi.fn();
			const onClose = vi.fn();
			secure.onerror = onError;
			secure.onclose = onClose;
			const raw = await pending;
			// Do not add an error listener: Node must be able to emit the close error safely.
			const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
			if (action === "cancel") secure.close();
			await closed;
			expect(secure.readyState).toBe(3);
			expect(onClose).toHaveBeenCalledTimes(1);
			if (action === "cancel") expect(onError).not.toHaveBeenCalled();
			else expect(onError).toHaveBeenCalledOnce();
		} finally {
			secure?.close();
			for (const socket of connections) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
