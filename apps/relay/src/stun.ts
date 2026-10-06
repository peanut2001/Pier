/**
 * A minimal STUN server (RFC 5389 Binding only): it tells a client the address and port its
 * UDP packets come from, which WebRTC needs to find a peer-to-peer path through NAT.
 * No authentication and no relaying (that would be TURN).
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { crc32 } from "node:zlib";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_SOFTWARE = 0x8022;
const ATTR_FINGERPRINT = 0x8028;
const FINGERPRINT_XOR = 0x5354554e;
const SOFTWARE = "pier-relay";

function attribute(type: number, value: Buffer): Buffer {
	const padded = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
	padded.writeUInt16BE(type, 0);
	padded.writeUInt16BE(value.length, 2);
	value.copy(padded, 4);
	return padded;
}

/** The (XOR-)MAPPED-ADDRESS value for `address:port`. */
function addressValue(address: string, port: number, xor: Buffer | undefined): Buffer {
	const v4 = isIPv4(address);
	const ip = v4 ? Buffer.from(address.split(".").map(Number)) : ipv6Bytes(address);
	const value = Buffer.alloc(4 + ip.length);
	value.writeUInt8(0, 0);
	value.writeUInt8(v4 ? 0x01 : 0x02, 1);
	value.writeUInt16BE(xor ? port ^ (MAGIC_COOKIE >>> 16) : port, 2);
	for (let i = 0; i < ip.length; i++) value[4 + i] = xor ? (ip[i] as number) ^ (xor[i] as number) : (ip[i] as number);
	return value;
}

function ipv6Bytes(address: string): Buffer {
	const [head = "", tail = ""] = address.split("%")[0]?.split("::") ?? [];
	const parse = (part: string) => (part ? part.split(":") : []);
	const left = parse(head);
	const right = parse(tail);
	const groups = address.includes("::")
		? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
		: left;
	const out = Buffer.alloc(16);
	groups.slice(0, 8).forEach((group, i) => {
		out.writeUInt16BE(Number.parseInt(group || "0", 16) & 0xffff, i * 2);
	});
	return out;
}

/** Build the Binding success response for a request from `from`. */
export function bindingResponse(request: Buffer, from: { address: string; port: number }): Buffer | undefined {
	if (request.length < 20 || (request[0] as number) & 0xc0) return undefined;
	if (request.readUInt16BE(0) !== BINDING_REQUEST || request.readUInt32BE(4) !== MAGIC_COOKIE) return undefined;
	if (request.readUInt16BE(2) + 20 !== request.length) return undefined;
	const transactionId = request.subarray(8, 20);
	// An IPv4 client on a dual-stack socket shows up as ::ffff:a.b.c.d.
	const address =
		from.address.startsWith("::ffff:") && isIPv4(from.address.slice(7)) ? from.address.slice(7) : from.address;
	const xorKey = Buffer.alloc(16);
	xorKey.writeUInt32BE(MAGIC_COOKIE, 0);
	transactionId.copy(xorKey, 4);
	const attributes = Buffer.concat([
		attribute(ATTR_XOR_MAPPED_ADDRESS, addressValue(address, from.port, xorKey)),
		attribute(ATTR_MAPPED_ADDRESS, addressValue(address, from.port, undefined)),
		attribute(ATTR_SOFTWARE, Buffer.from(SOFTWARE)),
	]);
	const header = Buffer.alloc(20);
	header.writeUInt16BE(BINDING_SUCCESS, 0);
	// Length includes the FINGERPRINT attribute (8 bytes) that follows.
	header.writeUInt16BE(attributes.length + 8, 2);
	header.writeUInt32BE(MAGIC_COOKIE, 4);
	transactionId.copy(header, 8);
	const body = Buffer.concat([header, attributes]);
	const fingerprint = Buffer.alloc(4);
	fingerprint.writeUInt32BE((crc32(body) ^ FINGERPRINT_XOR) >>> 0, 0);
	return Buffer.concat([body, attribute(ATTR_FINGERPRINT, fingerprint)]);
}

export interface StunServer {
	port: number;
	close(): Promise<void>;
}

/** Listen for STUN Binding requests on `port` (IPv4 and IPv6 where available). */
export async function startStunServer(options: { port: number; host?: string }): Promise<StunServer> {
	const bind = (socket: Socket, host: string) =>
		new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.bind(options.port, host, () => {
				socket.off("error", reject);
				resolve();
			});
		});
	let socket = createSocket({ type: "udp6", ipv6Only: false });
	try {
		await bind(socket, options.host ?? "::");
	} catch {
		socket.close();
		socket = createSocket("udp4");
		await bind(socket, options.host && isIPv4(options.host) ? options.host : "0.0.0.0");
	}
	socket.on("message", (message: Buffer, from: RemoteInfo) => {
		const response = bindingResponse(message, from);
		if (response) socket.send(response, from.port, from.address);
	});
	socket.on("error", () => {});
	return {
		port: socket.address().port,
		close: () => new Promise((resolve) => socket.close(() => resolve())),
	};
}
