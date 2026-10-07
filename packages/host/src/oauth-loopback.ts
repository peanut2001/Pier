import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type LoopbackCallbackPage, type LoopbackRequest, PierProtocolError } from "@pier/protocol";

/**
 * Loopback redirects for browser sign-ins (RFC 8252): the page the browser shows when it returns
 * to Pier, and relays that catch the redirect on this computer for a sign-in that runs on another
 * computer's host (`loopback.*`, 1.28).
 *
 * The browser runs on the computer in front of the user, so it can only return to that computer's
 * loopback address. A relay listens there and hands every callback to the local UI, which forwards
 * it to the host that started the sign-in (`account.authorizeCallback`) and answers the browser
 * with that host's outcome. The PKCE verifier never leaves that host, so a code caught here is
 * useless on its own.
 */

/** How long a relay may wait for its callback before it closes. */
const RELAY_TTL_MS = 11 * 60_000;
/** How long the browser waits for the outcome before it is told to return to Pier. */
const RESPONSE_TIMEOUT_MS = 60_000;
/** Callbacks a relay keeps for the UI at once; more are turned away. */
const MAX_QUEUED = 8;
const MAX_QUERY_LENGTH = 8000;

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The page the browser shows after returning from the site's consent page. */
export function callbackPage(res: ServerResponse, status: number, title: string, detail: string): void {
	const ok = status === 200;
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
		"x-content-type-options": "nosniff",
	});
	res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Pier</title>
<style>body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1f2328}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:12px 0 8px}p{color:#57606a;margin:0}
.mark{font-size:36px;color:${ok ? "#1a7f37" : "#cf222e"}}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}p{color:#8d96a0}}</style>
</head><body><main><div class="mark">${ok ? "✓" : "✕"}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`);
}

/**
 * Whether `uri` is a loopback redirect another computer's host may hand to the site:
 * `http://127.0.0.1:<port>/callback`, nothing else.
 */
export function isLoopbackRedirect(uri: string): boolean {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	return (
		url.protocol === "http:" &&
		url.hostname === "127.0.0.1" &&
		url.port !== "" &&
		url.pathname === "/callback" &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash
	);
}

interface Pending {
	request: LoopbackRequest;
	res: ServerResponse;
	timer: ReturnType<typeof setTimeout>;
}

interface Relay {
	id: string;
	connectionId: string;
	server: Server;
	redirectUri: string;
	expiresAt: number;
	timer: ReturnType<typeof setTimeout>;
	/** Callbacks not yet taken with `next`. */
	queue: LoopbackRequest[];
	/** Callbacks whose browser waits for `respond`. */
	pending: Map<string, Pending>;
	/** A `next` waiting for the next callback. */
	waiter?: { resolve(request: LoopbackRequest): void; reject(error: Error): void };
	closed: boolean;
}

export class LoopbackRelays {
	private readonly relays = new Map<string, Relay>();

	/** Listen on a random loopback port for one sign-in's redirect. */
	async open(connectionId: string): Promise<{ relayId: string; redirectUri: string; expiresAt: string }> {
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const { port } = server.address() as AddressInfo;
		const expiresAt = Date.now() + RELAY_TTL_MS;
		const relay: Relay = {
			id: randomUUID(),
			connectionId,
			server,
			redirectUri: `http://127.0.0.1:${port}/callback`,
			expiresAt,
			timer: setTimeout(() => this.end(relay), RELAY_TTL_MS),
			queue: [],
			pending: new Map(),
			closed: false,
		};
		relay.timer.unref?.();
		server.on("request", (req, res) => this.receive(relay, req, res));
		this.relays.set(relay.id, relay);
		return { relayId: relay.id, redirectUri: relay.redirectUri, expiresAt: new Date(expiresAt).toISOString() };
	}

	private receive(relay: Relay, req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", relay.redirectUri);
		if (req.method !== "GET" || url.pathname !== "/callback") {
			res.writeHead(404).end();
			return;
		}
		if (url.search.length > MAX_QUERY_LENGTH || relay.pending.size >= MAX_QUEUED) {
			callbackPage(res, 429, "请求过多", "请回到 Pier 重新发起授权。");
			return;
		}
		const request: LoopbackRequest = { requestId: randomUUID(), query: url.search };
		const pending: Pending = {
			request,
			res,
			timer: setTimeout(
				() => this.answer(relay, request.requestId, 200, "已收到授权", "请回到 Pier 查看登录结果。"),
				RESPONSE_TIMEOUT_MS,
			),
		};
		pending.timer.unref?.();
		relay.pending.set(request.requestId, pending);
		res.on("close", () => {
			clearTimeout(pending.timer);
			relay.pending.delete(request.requestId);
		});
		const waiter = relay.waiter;
		if (waiter) {
			relay.waiter = undefined;
			waiter.resolve(request);
		} else {
			relay.queue.push(request);
		}
	}

	private relay(connectionId: string, relayId: string): Relay {
		const relay = this.relays.get(relayId);
		if (!relay || relay.connectionId !== connectionId) {
			throw new PierProtocolError("NOT_FOUND", "浏览器授权已结束，请重新授权");
		}
		return relay;
	}

	/** The next callback the browser made (waits for one). */
	next(connectionId: string, relayId: string): Promise<LoopbackRequest> {
		const relay = this.relay(connectionId, relayId);
		const queued = relay.queue.shift();
		if (queued) return Promise.resolve(queued);
		if (relay.closed) return Promise.reject(new PierProtocolError("NOT_FOUND", "浏览器授权已结束，请重新授权"));
		if (relay.waiter) throw new PierProtocolError("CONFLICT", "已经在等待浏览器回调");
		return new Promise((resolve, reject) => {
			relay.waiter = { resolve, reject };
		});
	}

	/** Answer the browser of a callback with the page to show. */
	respond(connectionId: string, relayId: string, requestId: string, page: LoopbackCallbackPage): boolean {
		const relay = this.relay(connectionId, relayId);
		return this.answer(relay, requestId, page.status, page.title, page.detail);
	}

	private answer(relay: Relay, requestId: string, status: number, title: string, detail: string): boolean {
		const pending = relay.pending.get(requestId);
		if (!pending) return false;
		relay.pending.delete(requestId);
		clearTimeout(pending.timer);
		callbackPage(pending.res, status, title, detail);
		return true;
	}

	close(connectionId: string, relayId: string): boolean {
		const relay = this.relays.get(relayId);
		if (!relay || relay.connectionId !== connectionId) return false;
		this.end(relay);
		return true;
	}

	/** Stop listening; browsers still waiting are told to return to Pier. */
	private end(relay: Relay): void {
		if (relay.closed) return;
		relay.closed = true;
		clearTimeout(relay.timer);
		this.relays.delete(relay.id);
		for (const requestId of [...relay.pending.keys()]) {
			this.answer(relay, requestId, 200, "已收到授权", "请回到 Pier 查看登录结果。");
		}
		relay.queue.length = 0;
		relay.waiter?.reject(new PierProtocolError("NOT_FOUND", "浏览器授权已结束，请重新授权"));
		relay.waiter = undefined;
		relay.server.close();
		relay.server.closeIdleConnections?.();
	}

	connectionClosed(connectionId: string): void {
		for (const relay of [...this.relays.values()]) if (relay.connectionId === connectionId) this.end(relay);
	}

	closeAll(): void {
		for (const relay of [...this.relays.values()]) this.end(relay);
	}
}
