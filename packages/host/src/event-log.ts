import { randomUUID } from "node:crypto";

export interface LoggedEvent<T> {
	seq: number;
	event: T;
}

export const DEFAULT_EVENT_LOG_CAPACITY = 5000;

/**
 * Per-session event log: assigns monotonically increasing sequence numbers and
 * keeps the most recent events in a fixed-size ring buffer for reconnect replay.
 */
export class EventLog<T> {
	/** Identifies this log instance. A `sinceSeq` from another epoch cannot be replayed. */
	readonly epoch: string;
	readonly capacity: number;
	private readonly buffer: Array<LoggedEvent<T> | undefined>;
	private seq = 0;

	constructor(capacity: number = DEFAULT_EVENT_LOG_CAPACITY, epoch: string = randomUUID()) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError("EventLog capacity must be a positive integer");
		}
		this.capacity = capacity;
		this.epoch = epoch;
		this.buffer = new Array(capacity);
	}

	/** Seq of the most recently appended event (0 when empty). */
	get currentSeq(): number {
		return this.seq;
	}

	/** Seq of the oldest event still retained (currentSeq + 1 when empty). */
	get oldestSeq(): number {
		return Math.max(1, this.seq - this.capacity + 1);
	}

	get size(): number {
		return Math.min(this.seq, this.capacity);
	}

	append(event: T): LoggedEvent<T> {
		this.seq += 1;
		const entry = { seq: this.seq, event };
		this.buffer[(this.seq - 1) % this.capacity] = entry;
		return entry;
	}

	/**
	 * Events with `seq > sinceSeq`, oldest first.
	 * Returns `undefined` when the gap cannot be filled from the buffer, or when
	 * `sinceSeq` is ahead of this log (it belongs to a different log history).
	 */
	since(sinceSeq: number): LoggedEvent<T>[] | undefined {
		if (!Number.isInteger(sinceSeq) || sinceSeq < 0 || sinceSeq > this.seq) return undefined;
		if (sinceSeq + 1 < this.oldestSeq) return undefined;
		const result: LoggedEvent<T>[] = [];
		for (let s = sinceSeq + 1; s <= this.seq; s++) {
			const entry = this.buffer[(s - 1) % this.capacity];
			if (!entry || entry.seq !== s) return undefined;
			result.push(entry);
		}
		return result;
	}
}
