import type { LoopbackCallbackPage, LoopbackRequest } from "@pier/protocol";

/**
 * Browser sign-in for another computer's Pier (protocol 1.28). The browser runs on this computer
 * and can only return to this computer's loopback address, so this computer's host catches the
 * redirect (`loopback.*`) and the app forwards each callback to the host that started the sign-in
 * (`account.authorizeCallback`), then shows its outcome in the browser.
 */
export interface CallbackRelay {
	/** The next callback the browser made on this computer (rejects once the relay is closed). */
	next(): Promise<LoopbackRequest>;
	/** Hand a callback to the computer that started the sign-in; resolves with the page to show. */
	forward(query: string): Promise<LoopbackCallbackPage>;
	/** Show the page in the browser that made the callback. */
	respond(requestId: string, page: LoopbackCallbackPage): Promise<unknown>;
}

export interface ForwardingCallbacks {
	/** Wait (at most `graceMs`) for the callback being forwarded, so its browser gets the real outcome. */
	settle(graceMs?: number): Promise<void>;
}

/** The page shown when the computer that started the sign-in could not take the callback. */
export function forwardFailurePage(error: unknown): LoopbackCallbackPage {
	const message = error instanceof Error ? error.message : String(error);
	return { status: 400, title: "授权失败", detail: `${message}。请回到 Pier 重新授权。` };
}

/**
 * Forward callbacks until the relay closes or `active()` turns false. Failures never escape:
 * the sign-in's own wait reports the outcome.
 */
export function forwardCallbacks(relay: CallbackRelay, active: () => boolean): ForwardingCallbacks {
	let inflight: Promise<void> = Promise.resolve();
	const loop = async () => {
		while (active()) {
			let request: LoopbackRequest;
			try {
				request = await relay.next();
			} catch {
				return;
			}
			if (!active()) return;
			const handled = (async () => {
				let page: LoopbackCallbackPage;
				try {
					page = await relay.forward(request.query);
				} catch (error) {
					page = forwardFailurePage(error);
				}
				await relay.respond(request.requestId, page).catch(() => undefined);
			})();
			inflight = handled;
			await handled;
		}
	};
	void loop();
	return {
		async settle(graceMs = 5_000) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				inflight,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, graceMs);
				}),
			]);
			clearTimeout(timer);
		},
	};
}
