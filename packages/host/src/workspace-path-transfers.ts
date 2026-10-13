import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { PierProtocolError, type WorkspacePathTransferResult } from "@pier/protocol";
import { fsError, normalizeRelativePath, resolveInside, workspaceRealRoot } from "./workspace-files.ts";

async function entryPath(root: string, path: string): Promise<string> {
	const parts = path.split("/");
	const name = parts.pop() as string;
	const parent = await resolveInside(root, parts.join("/"), "directory");
	if (!(await lstat(parent)).isDirectory()) throw new PierProtocolError("BAD_REQUEST", "Parent is not a directory");
	return join(parent, name);
}

function contains(parent: string, path: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function kindAt(path: string): Promise<WorkspacePathTransferResult["kind"] | undefined> {
	try {
		const info = await lstat(path);
		return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Does not follow links; includes hidden files and every empty directory. */
async function treeVersion(path: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = async (full: string, name: string): Promise<void> => {
		const info = await lstat(full);
		hash.update(JSON.stringify([name, info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]));
		if (info.isSymbolicLink()) hash.update(await readlink(full));
		else if (info.isDirectory()) {
			for (const child of (await readdir(full)).sort()) await walk(join(full, child), `${name}/${child}`);
		} else if (!info.isFile()) throw new PierProtocolError("BAD_REQUEST", `Cannot transfer special file: ${name}`);
	};
	await walk(path, "");
	return hash.digest("hex");
}

/**
 * Transfers an entry without following its symlinks. Copies are staged next to the destination;
 * same-filesystem moves use rename, keeping permissions and all directory contents intact.
 * Existing directories or links are never replaced. Cross-filesystem moves keep their source
 * if it changed during the copy.
 */
export async function transferWorkspacePath(
	sourceWorkspaceRoot: string,
	path: string,
	destinationWorkspaceRoot: string,
	destinationPath: string,
	mode: "copy" | "move",
	overwrite = false,
): Promise<WorkspacePathTransferResult> {
	const sourceRel = normalizeRelativePath(path);
	const destinationRel = normalizeRelativePath(destinationPath);
	if (!sourceRel || !destinationRel) throw new PierProtocolError("BAD_REQUEST", "Cannot transfer a workspace root");
	const sourceRoot = await workspaceRealRoot(sourceWorkspaceRoot);
	const destinationRoot = await workspaceRealRoot(destinationWorkspaceRoot);
	const source = await entryPath(sourceRoot, sourceRel);
	const destination = await entryPath(destinationRoot, destinationRel);
	let staging: string | undefined;
	try {
		const sourceInfo = await lstat(source);
		const kind = sourceInfo.isFile() ? "file" : sourceInfo.isDirectory() ? "directory" : "other";
		if (kind === "other" && !sourceInfo.isSymbolicLink()) {
			throw new PierProtocolError("BAD_REQUEST", "Cannot transfer a special file");
		}
		if (source === destination) throw new PierProtocolError("BAD_REQUEST", "Source and destination are the same path");
		if (kind === "directory" && contains(source, destination)) {
			throw new PierProtocolError("BAD_REQUEST", "Cannot transfer a directory into itself or its descendants");
		}
		const checkDestination = async () => {
			const existing = await kindAt(destination);
			if (existing && !(overwrite && existing === "file" && kind === "file")) {
				throw new PierProtocolError("CONFLICT", `Destination already exists: ${destinationRel}`, { kind: existing });
			}
		};
		await checkDestination();
		const result: WorkspacePathTransferResult = { sourcePath: sourceRel, path: destinationRel, kind };
		if (mode === "move") {
			try {
				await rename(source, destination);
				return result;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			}
		}
		const before = await treeVersion(source);
		staging = await mkdtemp(join(dirname(destination), ".pier-transfer-"));
		const staged = join(staging, "entry");
		await cp(source, staged, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
		if (before !== (await treeVersion(source))) {
			throw new PierProtocolError("CONFLICT", "Source changed during the copy; keeping the source");
		}
		await checkDestination();
		await rename(staged, destination);
		if (mode === "move") {
			if (before !== (await treeVersion(source))) {
				throw new PierProtocolError("CONFLICT", "Destination copied, but source changed; keeping the source");
			}
			await rm(source, { recursive: kind === "directory", maxRetries: 2 });
		}
		return result;
	} catch (error) {
		if (error instanceof PierProtocolError) throw error;
		return fsError(error, sourceRel);
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}
