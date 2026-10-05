import { type IceServer, type RelayMode } from "@pier/crypto";
export declare const RELAY_VERSION = "0.2.20";
export interface RelayServerOptions {
	/** TCP port for HTTP / WebSocket (default 7480; 0 picks a free port). */
	port?: number;
	/** Interface to bind (default: all). */
	host?: string;
	/** `private` (hosts need a token) or `open` (any host may register). */
	mode: RelayMode;
	/** Access tokens accepted from hosts in private mode. */
	tokens?: string[];
	/** UDP port of the built-in STUN server (default 3478; `false` turns it off). */
	stunPort?: number | false;
	/**
	 * Name or IP clients reach this server at, for the STUN URL announced to hosts. By default
	 * the `Host` header of each host's connection is used.
	 */
	publicHost?: string;
	/** More STUN / TURN servers to announce to hosts (e.g. a public STUN server). */
	iceServers?: IceServer[];
	/** Registered hosts at most (default 10 000 in private mode, 1000 in open mode). */
	maxHosts?: number;
	/** Concurrent device connections per host (default 32). */
	maxStreamsPerHost?: number;
	/** Connection attempts per client IP per minute (default 120). */
	connectsPerMinute?: number;
	/** Bytes per second per connection and direction, 0 for no limit (default: 0 private, 2 MiB/s open). */
	bytesPerSecond?: number;
	/** Take the client address from `X-Forwarded-For` / `X-Real-IP` (behind a reverse proxy). */
	trustProxy?: boolean;
	/** How long a host has to pick up a device connection (default 10 s). */
	acceptTimeoutMs?: number;
	/** Ping interval for dead-connection detection (default 30 s). */
	heartbeatMs?: number;
	log?: (message: string) => void;
}
export interface RelayServer {
	/** `ws://host:port` of the listener. */
	url: string;
	port: number;
	/** UDP port of the STUN server, if running. */
	stunPort: number | undefined;
	stats(): {
		hosts: number;
		streams: number;
	};
	close(): Promise<void>;
}
export declare function startRelayServer(options: RelayServerOptions): Promise<RelayServer>;
