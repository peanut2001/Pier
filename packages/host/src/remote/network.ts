import { networkInterfaces } from "node:os";
import { Bonjour } from "bonjour-service";

/** Format `host:port`, bracketing IPv6 literals. */
export function formatAddress(host: string, port: number): string {
	return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function isPrivateV4(ip: string): boolean {
	return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

/**
 * Candidate addresses a device on the same network (or tailnet) can reach this host
 * at: non-internal IPv4 (private ranges and Tailscale CGNAT first). IPv6 (global/ULA,
 * never link-local) is only used when there is no IPv4 address, to keep the QR code
 * small. At most four addresses.
 */
export function listLanAddresses(port: number): string[] {
	const v4: Array<{ ip: string; rank: number }> = [];
	const v6: string[] = [];
	for (const [name, infos] of Object.entries(networkInterfaces())) {
		for (const info of infos ?? []) {
			if (info.internal) continue;
			if (info.family === "IPv4") {
				// Docker / libvirt bridges are rarely reachable from a phone.
				const virtual = /^(docker|br-|veth|virbr|vmnet|cni|flannel)/.test(name);
				v4.push({ ip: info.address, rank: (virtual ? 2 : 0) + (isPrivateV4(info.address) ? 0 : 1) });
			} else if (info.family === "IPv6" && !info.address.toLowerCase().startsWith("fe80")) {
				v6.push(info.address);
			}
		}
	}
	v4.sort((a, b) => a.rank - b.rank);
	const unique = [...new Set(v4.length ? v4.map((a) => a.ip) : v6)];
	return unique.slice(0, 4).map((ip) => formatAddress(ip, port));
}

export interface MdnsAdvertisement {
	stop(): Promise<void>;
}

/**
 * Advertise `_pier._tcp` on the local network. The TXT record carries only the host id
 * and protocol version; pairing still requires the QR code.
 */
export function advertiseMdns(options: {
	name: string;
	port: number;
	hostId: string;
	protocolVersion: string;
	onError?: (error: Error) => void;
}): MdnsAdvertisement {
	const bonjour = new Bonjour({}, (error: Error) => options.onError?.(error));
	const service = bonjour.publish({
		name: `Pier on ${options.name}`.slice(0, 63),
		type: "pier",
		protocol: "tcp",
		port: options.port,
		txt: { id: options.hostId, pv: options.protocolVersion },
	});
	service.on("error", (error: Error) => options.onError?.(error));
	return {
		stop: () =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 1000);
				bonjour.unpublishAll(() => {
					bonjour.destroy(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			}),
	};
}
