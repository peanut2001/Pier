export const ERROR_CODES = [
	/** Frame or params failed validation. */
	"BAD_REQUEST",
	/** `host.hello` has not completed, or the token was rejected. */
	"UNAUTHENTICATED",
	/** The caller is authenticated but not allowed to call this method. */
	"FORBIDDEN",
	"NOT_FOUND",
	/** The target is in a state that does not allow the operation. */
	"CONFLICT",
	/** Major protocol versions differ. */
	"PROTOCOL_MISMATCH",
	/** Method known to the protocol but not implemented by this host yet. */
	"UNSUPPORTED",
	"TIMEOUT",
	"INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolErrorShape {
	code: ErrorCode;
	message: string;
	data?: unknown;
}

/** Error carried across the wire in a failed `res` frame. */
export class PierProtocolError extends Error {
	readonly code: ErrorCode;
	readonly data: unknown;

	constructor(code: ErrorCode, message: string, data?: unknown) {
		super(message);
		this.name = "PierProtocolError";
		this.code = code;
		this.data = data;
	}

	toJSON(): ProtocolErrorShape {
		return this.data === undefined
			? { code: this.code, message: this.message }
			: { code: this.code, message: this.message, data: this.data };
	}
}
