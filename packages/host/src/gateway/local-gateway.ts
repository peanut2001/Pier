import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { PierHost } from "../host.ts";

/** Origins of the Tauri WebView (production and Vite dev server). Clients without an Origin (CLI) are allowed. */
export const DEFAULT_ALLOWED_ORIGINS = [
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
	"http://localhost:1420",
	"http://127.0.0.1:1420",
];

export interface LocalGatewayOptions {
	/** 0 picks a free port. */
	port?: number;
	allowedOrigins?: string[];
	/** Maximum incoming frame size (images are sent inline). */
	maxPayloadBytes?: number;
}

export interface LocalGateway {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

/**
 * WebSocket gateway bound to 127.0.0.1 for the desktop UI and local tools. Browsers
 * cannot set headers on WebSockets, so the local token is checked in `host.hello`;
 * the Origin check keeps other web pages from even opening a connection.
 */
export function startLocalGateway(host: PierHost, options: LocalGatewayOptions = {}): Promise<LocalGateway> {
	const allowed = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
	const wss = new WebSocketServer({
		host: "127.0.0.1",
		port: options.port ?? 0,
		maxPayload: options.maxPayloadBytes ?? 64 * 1024 * 1024,
		verifyClient: (
			info: { origin: string; req: IncomingMessage },
			done: (ok: boolean, code?: number, message?: string) => void,
		) => {
			if (!info.origin || allowed.has(info.origin)) done(true);
			else done(false, 403, "Origin not allowed");
		},
	});

	wss.on("connection", (socket) => {
		const connection = host.connect(
			{
				send: (data) => socket.send(data),
				close: (code, reason) => socket.close(code, reason),
				get bufferedAmount() {
					return socket.bufferedAmount;
				},
			},
			"local",
		);
		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				connection.close(1003, "Binary frames are not supported");
				return;
			}
			void connection.receive(data.toString()).catch(() => connection.close(1011, "Internal error"));
		});
		socket.on("close", () => connection.onTransportClosed());
		socket.on("error", () => connection.onTransportClosed());
	});

	return new Promise((resolve, reject) => {
		wss.once("error", reject);
		wss.once("listening", () => {
			wss.off("error", reject);
			const port = (wss.address() as AddressInfo).port;
			resolve({
				port,
				url: `ws://127.0.0.1:${port}`,
				close: () =>
					new Promise<void>((done) => {
						for (const client of wss.clients) client.terminate();
						wss.close(() => done());
					}),
			});
		});
	});
}
