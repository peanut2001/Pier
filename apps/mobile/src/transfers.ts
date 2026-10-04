/**
 * Moving files between the phone and a workspace on the computer: pick local files to upload,
 * and save workspace files into a folder the user picks on the phone.
 */

import { Directory, File, FileMode } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import type { DownloadSink, MobileStore, UploadSource } from "./store.ts";

/** A local file chosen for upload. */
export interface PickedFile {
	name: string;
	size: number;
	/** Open the file for reading; call `close` when done. */
	open: () => UploadSource & { close: () => void };
}

function fromFile(file: File, name?: string): PickedFile {
	return {
		name: name || file.name || "file",
		size: file.size ?? 0,
		open: () => {
			const handle = file.open(FileMode.ReadOnly);
			return {
				size: handle.size ?? file.size ?? 0,
				read: (length) => handle.readBytes(length),
				close: () => handle.close(),
			};
		},
	};
}

/** Let the user pick any files on the phone. Resolves to none when cancelled. */
export async function pickDocuments(): Promise<PickedFile[]> {
	const result = await File.pickFileAsync({ multipleFiles: true });
	if (result.canceled) return [];
	return result.result.map((file) => fromFile(file));
}

/** Let the user pick photos or videos from the library. */
export async function pickMedia(): Promise<PickedFile[]> {
	const result = await ImagePicker.launchImageLibraryAsync({
		mediaTypes: ["images", "videos"],
		allowsMultipleSelection: true,
		quality: 1,
	});
	if (result.canceled) return [];
	return result.assets.map((asset) => {
		const file = new File(asset.uri);
		const name = asset.fileName || asset.uri.split("/").pop() || "photo";
		return fromFile(file, name);
	});
}

const MIME_BY_EXTENSION: Record<string, string> = {
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	zip: "application/zip",
	mp4: "video/mp4",
	mov: "video/quicktime",
	mp3: "audio/mpeg",
	html: "text/html",
	csv: "text/csv",
};

export function mimeTypeFor(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Whether saving files to a folder on the phone is supported here. */
export const canSaveToPhone = Platform.OS === "android" || Platform.OS === "ios";

/**
 * Ask for a folder on the phone and create `name` in it. Resolves to a sink for the bytes, or
 * `undefined` when the user cancelled.
 */
export async function createPhoneFile(
	name: string,
): Promise<(DownloadSink & { close: () => void; uri: string; folder: string }) | undefined> {
	let directory: Directory;
	try {
		directory = await Directory.pickDirectoryAsync();
	} catch (error) {
		// Cancelling the picker rejects.
		if (/cancel/i.test(error instanceof Error ? error.message : String(error))) return undefined;
		throw error;
	}
	if (!directory) return undefined;
	const file = directory.createFile(name, mimeTypeFor(name));
	const handle = file.open(FileMode.WriteOnly);
	return {
		uri: file.uri,
		folder: decodeURIComponent(directory.name || directory.uri),
		write: (bytes) => handle.writeBytes(bytes),
		close: () => handle.close(),
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Save a workspace file into a folder the user picks on the phone, reporting progress as text
 * (`undefined` once finished).
 */
export async function saveToPhone(
	store: MobileStore,
	workspaceId: string,
	path: string,
	onProgress?: (text: string | undefined) => void,
): Promise<void> {
	const name = path.split("/").pop() || "file";
	let target: Awaited<ReturnType<typeof createPhoneFile>>;
	try {
		target = await createPhoneFile(name);
	} catch (error) {
		store.toast("error", `无法在手机上保存：${errorText(error)}`);
		return;
	}
	if (!target) return;
	try {
		await store.downloadFile(workspaceId, path, target, (received, size) =>
			onProgress?.(`正在下载 ${name}：${size ? Math.round((received / size) * 100) : 100}%`),
		);
		store.toast("info", `已保存到手机：${target.folder}/${name}`);
	} catch (error) {
		store.toast("error", `下载失败：${errorText(error)}`);
	} finally {
		target.close();
		onProgress?.(undefined);
	}
}
