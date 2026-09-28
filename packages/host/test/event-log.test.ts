import type { EventFrame } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaCoalescer } from "../src/coalesce.ts";
import { EventLog } from "../src/event-log.ts";

describe("EventLog", () => {
	it("assigns increasing seqs starting at 1", () => {
		const log = new EventLog<string>(10);
		expect(log.currentSeq).toBe(0);
		expect(log.append("a").seq).toBe(1);
		expect(log.append("b").seq).toBe(2);
		expect(log.currentSeq).toBe(2);
	});

	it("replays events after a seq within the buffer", () => {
		const log = new EventLog<string>(10);
		for (const e of ["a", "b", "c", "d"]) log.append(e);
		expect(log.since(0)?.map((e) => e.event)).toEqual(["a", "b", "c", "d"]);
		expect(log.since(2)?.map((e) => e.event)).toEqual(["c", "d"]);
		expect(log.since(4)).toEqual([]);
	});

	it("reports a gap once events fall out of the ring buffer", () => {
		const log = new EventLog<number>(3);
		for (let i = 1; i <= 5; i++) log.append(i);
		expect(log.oldestSeq).toBe(3);
		expect(log.size).toBe(3);
		expect(log.since(2)?.map((e) => e.event)).toEqual([3, 4, 5]);
		expect(log.since(1)).toBeUndefined();
		expect(log.since(0)).toBeUndefined();
	});

	it("rejects seqs ahead of the log (a different history)", () => {
		const log = new EventLog<number>(3);
		log.append(1);
		expect(log.since(5)).toBeUndefined();
		expect(log.since(-1)).toBeUndefined();
		expect(log.since(1.5)).toBeUndefined();
	});

	it("has a unique epoch per instance", () => {
		expect(new EventLog(1).epoch).not.toBe(new EventLog(1).epoch);
		expect(() => new EventLog(0)).toThrow(RangeError);
	});
});

function delta(seq: number, text: string, kind = "text_delta", contentIndex = 0, sessionId = "s"): EventFrame {
	return {
		type: "evt",
		sessionId,
		seq,
		event: { type: "message_update", usage: { seq }, assistantMessageEvent: { type: kind, contentIndex, delta: text } },
	};
}

describe("DeltaCoalescer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("passes everything through when the window is 0", () => {
		const out: EventFrame[] = [];
		const c = new DeltaCoalescer(0, (f) => out.push(f));
		c.push(delta(1, "a"));
		c.push(delta(2, "b"));
		expect(out.map((f) => f.seq)).toEqual([1, 2]);
	});

	it("merges consecutive deltas of the same block and keeps the last seq", () => {
		const out: EventFrame[] = [];
		const c = new DeltaCoalescer(50, (f) => out.push(f));
		c.push(delta(1, "Hel"));
		c.push(delta(2, "lo"));
		c.push(delta(3, "!"));
		expect(out).toHaveLength(0);
		vi.advanceTimersByTime(50);
		expect(out).toHaveLength(1);
		expect(out[0]?.seq).toBe(3);
		expect(out[0]?.event.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "Hello!" });
		expect(out[0]?.event.usage).toEqual({ seq: 3 });
	});

	it("flushes before a different block, kind, session, or event", () => {
		const out: EventFrame[] = [];
		const c = new DeltaCoalescer(50, (f) => out.push(f));
		c.push(delta(1, "a"));
		c.push(delta(2, "b", "text_delta", 1));
		c.push(delta(3, "c", "thinking_delta", 1));
		c.push(delta(4, "d", "thinking_delta", 1, "other"));
		c.push({ type: "evt", sessionId: "s", seq: 5, event: { type: "message_end" } });
		expect(out.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
	});

	it("does not merge non-delta message updates", () => {
		const out: EventFrame[] = [];
		const c = new DeltaCoalescer(50, (f) => out.push(f));
		c.push({
			type: "evt",
			sessionId: "s",
			seq: 1,
			event: { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		});
		expect(out).toHaveLength(1);
	});
});
