/** A push-based async iterable, used as the streaming input of an SDK or CLI. */
export class InputQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = [];
	private waiting: ((result: IteratorResult<T>) => void) | undefined;
	private closed = false;

	push(item: T): void {
		if (this.closed) return;
		const waiting = this.waiting;
		if (waiting) {
			this.waiting = undefined;
			waiting({ value: item, done: false });
		} else {
			this.items.push(item);
		}
	}

	close(): void {
		this.closed = true;
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
			return: () => {
				this.close();
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}
