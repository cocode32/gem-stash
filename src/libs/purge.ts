import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AUDIO_EXTENSIONS } from "../common/constants.ts";
import { exists } from "../common/file.helpers.ts";
import { parseErrorMsg } from "../common/format.helpers.ts";
import { clearPurged, findVerifiedSafeToDelete } from "./catalog.ts";

export type PurgeItem = {
	/**
	 * the inbox source to delete
	 */
	originalPath: string;
	/**
	 * where its processed copy lives (archive/<category>/...);
	 * its directory is where this folder's leftover non-media files get swept to.
	 */
	destPath: string;
	size: number;
};

export type PurgePlan = {
	onDisk: PurgeItem[];
	/**
	 * catalog rows whose source is already gone from disk; pointers get cleared.
	 */
	missing: string[];
};

export async function planPurge(db: DatabaseSync): Promise<PurgePlan> {
	const candidates = findVerifiedSafeToDelete(db);
	const onDisk: PurgeItem[] = [];
	const missing: string[] = [];
	for (const r of candidates) {
		if (!r.originalPath) continue;
		try {
			const s = await stat(r.originalPath);
			onDisk.push({ originalPath: r.originalPath, destPath: r.path, size: s.size });
		} catch {
			missing.push(r.originalPath);
		}
	}
	return { onDisk, missing };
}

export type PurgeEvent =
	| { kind: "deleted"; path: string }
	| { kind: "delete-error"; path: string; error: string }
	| { kind: "swept"; from: string; to: string }
	| { kind: "sweep-error"; from: string; error: string }
	| { kind: "removed-dir"; path: string }
	| { kind: "kept-dir"; path: string; reason: string };

/**
 * Deletes the verified inbox sources, clears their catalog pointers,
 * then for any inbox folder it fully emptied of media,
 * sweeps the leftover non-media files (cdparanoia.log, .cue, cover art, ...)
 * into the destination folder(s) their media landed in and removes the now-empty inbox folder.
 * inboxRoot bounds how far up the empty-folder removal walks.
 *
 * @param db The catalog db
 * @param inboxRoot The path to the inbox root directory
 * @param plan The execution plan
 */
export async function* executePurge(db: DatabaseSync, inboxRoot: string, plan: PurgePlan): AsyncGenerator<PurgeEvent> {
	const deleted: string[] = [];
	// inbox folder -> the distinct destination folders its media went to.
	// A folder whose media split across categories sweeps leftovers into every one of them.
	const destFoldersByFolder = new Map<string, Set<string>>();

	for (const item of plan.onDisk) {
		const folder = dirname(item.originalPath);
		if (!destFoldersByFolder.has(folder)) destFoldersByFolder.set(folder, new Set());
		try {
			await unlink(item.originalPath);
			deleted.push(item.originalPath);
			// biome-ignore lint/style/noNonNullAssertion: confirmed to exist above
			destFoldersByFolder.get(folder)!.add(dirname(item.destPath));
			yield { kind: "deleted", path: item.originalPath };
		} catch (e) {
			yield { kind: "delete-error", path: item.originalPath, error: parseErrorMsg(e) };
		}
	}

	// Clear catalog pointers for what we actually deleted plus the already-missing sources.
	// Any failed unlink keeps its pointer so a retry can find it.
	clearPurged(db, [...deleted, ...plan.missing]);

	for (const [folder, destFolders] of destFoldersByFolder) {
		if (destFolders.size === 0) continue; // every delete in this folder failed
		yield* sweepFolder(folder, [...destFolders], inboxRoot);
	}
}

/**
 * Move every leftover file out of a media-emptied inbox folder, then remove it.
 *
 * @param folder The root folder path
 * @param destFolders The destination folders to clear
 * @param inboxRoot The inbox root path
 */
async function* sweepFolder(folder: string, destFolders: string[], inboxRoot: string): AsyncGenerator<PurgeEvent> {
	let entries: Dirent[];
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch {
		return; // already gone
	}

	// If any media file is still here
	// (e.g. a source that failed its paranoia check),
	// leave the whole folder alone so nothing is swept prematurely.
	const hasMedia = entries.some((e) => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()));
	if (hasMedia) {
		yield { kind: "kept-dir", path: folder, reason: "still contains media files" };
		return;
	}

	for (const e of entries) {
		if (!e.isFile()) continue;
		const src = join(folder, e.name);
		try {
			// Dotfiles (.DS_Store and friends) are OS cruft.
			// Drop them rather than copying them into the pristine archive.
			if (!e.name.startsWith(".")) {
				for (const dest of destFolders) {
					await mkdir(dest, { recursive: true });
					const target = join(dest, e.name);
					if (await exists(target)) continue; // never overwrite at destination
					await copyFile(src, target);
					yield { kind: "swept", from: src, to: target };
				}
			}
			await unlink(src);
		} catch (err) {
			yield { kind: "sweep-error", from: src, error: parseErrorMsg(err) };
		}
	}

	yield* removeEmptyUp(folder, inboxRoot);
}

/**
 * Remove a folder and walk up removing empties, stopping below inboxRoot.
 * @param folder The folder to remove at
 * @param inboxRoot The inbox root path
 */
async function* removeEmptyUp(folder: string, inboxRoot: string): AsyncGenerator<PurgeEvent> {
	let cur = folder;
	while (cur !== inboxRoot && cur.startsWith(inboxRoot + sep)) {
		let remaining: string[];
		try {
			remaining = await readdir(cur);
		} catch {
			break;
		}
		if (remaining.length > 0) {
			yield { kind: "kept-dir", path: cur, reason: "not empty" };
			break;
		}
		try {
			await rmdir(cur);
			yield { kind: "removed-dir", path: cur };
		} catch (e) {
			yield { kind: "sweep-error", from: cur, error: parseErrorMsg(e) };
			break;
		}
		cur = dirname(cur);
	}
}
