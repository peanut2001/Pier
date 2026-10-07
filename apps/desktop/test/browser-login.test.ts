import type { LoopbackCallbackPage, LoopbackRequest } from "@pier/protocol";
import { describe, expect, it, vi } from "vitest";
import { forwardCallbacks } from "../src/lib/browser-login.ts";

/** A relay fed by the test: `push` plays the browser, `close` ends it. */
function fakeRelay(forward: (query: string) => Promise<LoopbackCallbackPage>) {
	const queue: LoopbackRequest[] = [];
	let waiter: { resolve(r: LoopbackRequest): void; reject(e: Error): void } | undefined;
	const responses: Array<{ requestId: string; page: LoopbackCallbackPage }> = [];
	let closed = false;
	return {
		responses,
		push(request: LoopbackRequest) {
			if (waiter) {
				const w = waiter;
				waiter = undefined;
				w.resolve(request);
			} else queue.push(request);
		},
		close() {
			closed = true;
			waiter?.reject(new Error("closed"));
		},
		relay: {
			next: () => {
				const queued = queue.shift();
				if (queued) return Promise.resolve(queued);
				if (closed) return Promise.reject(new Error("closed"));
				return new Promise<LoopbackRequest>((resolve, reject) => {
					waiter = { resolve, reject };
				});
			},
			forward,
			respond: async (requestId: string, page: LoopbackCallbackPage) => {
				responses.push({ requestId, page });
			},
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("forwarding browser callbacks to another computer", () => {
	it("answers each callback with the other computer's page, or a failure page", async () => {
		const fake = fakeRelay(async (query) => {
			if (query.includes("bad")) throw new Error("浏览器授权已结束，请重新授权");
			return { status: 200, title: "登录成功", detail: query };
		});
		const forwarding = forwardCallbacks(fake.relay, () => true);
		fake.push({ requestId: "r1", query: "?state=bad" });
		fake.push({ requestId: "r2", query: "?code=c&state=s" });
		await vi.waitFor(() => expect(fake.responses).toHaveLength(2));
		await forwarding.settle();
		expect(fake.responses).toEqual([
			{
				requestId: "r1",
				page: { status: 400, title: "授权失败", detail: "浏览器授权已结束，请重新授权。请回到 Pier 重新授权。" },
			},
			{ requestId: "r2", page: { status: 200, title: "登录成功", detail: "?code=c&state=s" } },
		]);
		fake.close();
	});

	it("stops once the sign-in is abandoned and waits only briefly for the outcome", async () => {
		let active = true;
		let release!: () => void;
		const fake = fakeRelay(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ status: 200, title: "ok", detail: "" });
				}),
		);
		const forwarding = forwardCallbacks(fake.relay, () => active);
		fake.push({ requestId: "r1", query: "?code=c" });
		await tick();
		// The forward is still running: settle gives up after the grace period.
		await forwarding.settle(10);
		expect(fake.responses).toHaveLength(0);
		release();
		await forwarding.settle(1000);
		expect(fake.responses).toHaveLength(1);

		active = false;
		fake.push({ requestId: "r2", query: "?code=late" });
		await tick();
		expect(fake.responses).toHaveLength(1);
		fake.close();
	});
});
