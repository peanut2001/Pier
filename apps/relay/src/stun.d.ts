/** Build the Binding success response for a request from `from`. */
export declare function bindingResponse(
	request: Buffer,
	from: {
		address: string;
		port: number;
	},
): Buffer | undefined;
export interface StunServer {
	port: number;
	close(): Promise<void>;
}
/** Listen for STUN Binding requests on `port` (IPv4 and IPv6 where available). */
export declare function startStunServer(options: { port: number; host?: string }): Promise<StunServer>;
