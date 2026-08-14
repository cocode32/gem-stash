import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { exists } from "../common/file.helpers.ts";
import { parseErrorMsg } from "../common/format.helpers.ts";
import { type AlbumGroup, consolidateAlbum, groupProcessedAlbums, writeAlbumSidecar } from "./album-sidecar.ts";
import { findProcessed } from "./catalog.ts";

export type ScaffoldPlanItem = {
	group: AlbumGroup;
	/**
	 * true when an album master already exists (and so holds hand-edits).
	 */
	exists: boolean;
};

/**
 * List every processed album and whether it already has a master. No writes.
 *
 * @param db The catalog db
 */
export async function planScaffold(db: DatabaseSync): Promise<ScaffoldPlanItem[]> {
	const groups = groupProcessedAlbums(findProcessed(db));
	const items: ScaffoldPlanItem[] = [];
	for (const group of groups) {
		items.push({ group, exists: await exists(group.albumSidecarPath) });
	}
	return items;
}

export type ScaffoldEvent =
	| { kind: "created" | "refreshed"; path: string; trackCount: number }
	| { kind: "skipped"; path: string; reason: string }
	| { kind: "error"; path: string; error: string };

/**
 * Build an album master for each album by consolidating its per-file sidecars
 * (or raw file tags). Existing masters are left alone unless overwrite is set,
 * because they hold the owner's hand-edits.
 *
 * @param items The scaffold plan
 * @param opts overwrite: rebuild masters that already exist
 */
export async function* executeScaffold(items: ScaffoldPlanItem[], opts: { overwrite: boolean }): AsyncGenerator<ScaffoldEvent> {
	for (const { group, exists: present } of items) {
		if (present && !opts.overwrite) {
			yield { kind: "skipped", path: group.albumSidecarPath, reason: "master already exists" };
			continue;
		}
		try {
			const sidecar = await consolidateAlbum(group);
			await mkdir(dirname(group.albumSidecarPath), { recursive: true });
			await writeAlbumSidecar(group.albumSidecarPath, sidecar);
			yield {
				kind: present ? "refreshed" : "created",
				path: group.albumSidecarPath,
				trackCount: sidecar.tracks.length,
			};
		} catch (e) {
			yield { kind: "error", path: group.albumSidecarPath, error: parseErrorMsg(e) };
		}
	}
}
