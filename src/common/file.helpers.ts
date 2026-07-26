import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * True if a path exists (file or directory). Never throws.
 */
export async function exists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Unlink that swallows errors (missing file, races on temp cleanup).
 * Used to clear stale temp files before an encode/strip and to clean up after failures.
 */
export async function safeUnlink(p: string): Promise<void> {
	try {
		await unlink(p);
	} catch {
		/* ignore */
	}
}

/**
 * Move a file, refusing to overwrite an existing destination.
 * Falls back to copy + unlink on a cross-device rename so the source stays
 * intact if the copy fails partway.
 */
export async function moveFile(srcPath: string, destPath: string): Promise<void> {
	if (await exists(destPath)) {
		throw new Error(`Destination already exists: ${destPath}`);
	}
	await mkdir(dirname(destPath), { recursive: true });
	try {
		await rename(srcPath, destPath);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EXDEV") {
			// Cross-device rename. Copy first, then unlink source only if the copy
			// succeeded; this keeps the source intact if anything fails.
			await copyFile(srcPath, destPath);
			await unlink(srcPath);
		} else {
			throw e;
		}
	}
}
