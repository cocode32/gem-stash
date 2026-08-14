// noinspection ExceptionCaughtLocallyJS -- expected behaviour where throws occur

import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { exists } from "../common/file.helpers.ts";
import { parseErrorMsg } from "../common/format.helpers.ts";
import {
	type AlbumGroup,
	type AlbumSidecar,
	effectiveTagsForTrack,
	groupProcessedAlbums,
	looksLikeCompilation,
	readAlbumSidecar,
	regenerateSingle,
} from "./album-sidecar.ts";
import { type FileRow, type FinalTags, findProcessed, recordTagged } from "./catalog.ts";
import { combineNumTotal, type EffectiveTags, readBackTags, verifyWritten, writeTags } from "./tagwrite.ts";

export type AlbumValidation = {
	/**
	 * Issues that make the album unsafe to write;
	 * the album is skipped until fixed.
	 */
	blocking: string[];
	/**
	 * Recommendations that do not block writing
	 * - recorded against each track
	 */
	warnings: string[];
	/**
	 * albumartist is empty (could not be agreed on at consolidation),
	 * so the user must supply the canonical one before writing.
	 */
	needsAlbumArtist: boolean;
	/**
	 * The album reads as a various-artists compilation (see looksLikeCompilation)
	 * but the flag is not set; the writer sets it to 1 so Apple files it as one
	 * record rather than splitting it per track artist.
	 */
	needsCompilation: boolean;
};

export type AlbumPlan = {
	group: AlbumGroup;
	/**
	 * The album master, or null when none exists yet.
	 * When it does not exist - run scaffold first.
	 */
	sidecar: AlbumSidecar | null;
	validation: AlbumValidation | null;
	/**
	 * Distinct `albumartist / artist` values found across the album's files,
	 * to offer as quick picks when prompting for a missing albumartist.
	 */
	albumArtistChoices: string[];
};

/**
 * An album that is ready to write:
 * - a master that exists,
 * - has been resolved (albumartist supplied, compilation set), and
 * - re-validated with no blockers.
 */
export type TagJob = {
	group: AlbumGroup;
	sidecar: AlbumSidecar;
	validation: AlbumValidation;
};

export type TagEvent =
	| { kind: "album-start"; artist: string; album: string; trackCount: number }
	| {
			kind: "track-ok";
			file: string;
			artEmbedded: boolean;
			artMissing: boolean;
			mismatches: string[];
	  }
	| { kind: "track-error"; file: string; error: string }
	| {
			kind: "album-done";
			artist: string;
			album: string;
			appleReady: boolean;
			ok: number;
			failed: number;
			warnings: string[];
	  };

/**
 * Plan a tag run: group every processed file into albums and, for each,
 * load the album master if present and validate it.
 * No files are touched.
 * The CLI resolves a missing `albumartist / compilation` flag against the returned plan,
 * then hands the ready albums to executeTagging.
 *
 * @param db The catalog db
 */
export async function planTagging(db: DatabaseSync): Promise<AlbumPlan[]> {
	const groups = groupProcessedAlbums(findProcessed(db));
	const plans: AlbumPlan[] = [];
	for (const group of groups) {
		const choices = albumArtistChoicesFor(group.rows);
		if (!(await exists(group.albumSidecarPath))) {
			plans.push({ group, sidecar: null, validation: null, albumArtistChoices: choices });
			continue;
		}
		const sidecar = await readAlbumSidecar(group.albumSidecarPath);
		plans.push({
			group,
			sidecar,
			validation: validateAlbum(sidecar),
			albumArtistChoices: choices,
		});
	}
	return plans;
}

/**
 * Validate an album master before writing.
 * Returns:
 * - Blocking issues (which skip the album),
 * - Warnings (recorded but non-blocking), and
 * - Whether the albumartist or compilation flag still needs resolving.
 *
 * @param sidecar The album master
 */
export function validateAlbum(sidecar: AlbumSidecar): AlbumValidation {
	const blocking: string[] = [];
	const warnings: string[] = [];
	const { album, tracks } = sidecar;

	// track/disc numbers: every track needs one, and (disc, track) must be unique.
	const seen = new Set<string>();
	const missingNum: string[] = [];
	const dupes: string[] = [];
	for (const t of tracks) {
		const num = t.trackNumber.trim();
		if (!num) {
			missingNum.push(t.file);
			continue;
		}
		const disc = t.discNumber.trim() || "1";
		const pair = `${disc}/${num}`;
		if (seen.has(pair)) dupes.push(`${t.file} (disc ${disc}, track ${num})`);
		else seen.add(pair);
	}
	if (missingNum.length) blocking.push(`missing track number: ${missingNum.join(", ")}`);
	if (dupes.length) blocking.push(`duplicate disc/track numbers: ${dupes.join("; ")}`);

	if (!album.genre.trim()) warnings.push("genre is empty (recommended for Apple Music)");

	return {
		blocking,
		warnings,
		needsAlbumArtist: album.albumArtist.trim() === "",
		// Only guess when the master has not decided. An explicit "0" is a real
		// answer, not an absent one: a label-as-album-artist release reads like a
		// compilation to the heuristic, but flagging it would move it out of that
		// artist and into Apple's Compilations bucket, which is the opposite of
		// what setting the label as album artist was for.
		needsCompilation: album.compilation.trim() === "" && looksLikeCompilation(album, tracks),
	};
}

/**
 * Audio is never touched.
 * Per-track and per-album events stream out for the log.
 *
 * - Write tags + front art onto every track of each ready album,
 * - Read them back to confirm,
 * - Regenerate the per-file sidecars from the master, and
 * - Record the final tag state plus a per-album Apple-ready verdict in the catalog.
 *
 * @param db The catalog db
 * @param jobs Resolved, validated albums to write
 */
export async function* executeTagging(db: DatabaseSync, jobs: TagJob[]): AsyncGenerator<TagEvent> {
	for (const { group, sidecar, validation } of jobs) {
		yield {
			kind: "album-start",
			artist: group.artist,
			album: group.album,
			trackCount: sidecar.tracks.length,
		};

		const rowByFile = new Map(group.rows.map((r) => [r.relativePath, r]));
		type Res = { row: FileRow; effective: EffectiveTags; mismatches: string[]; error?: string };
		const results: Res[] = [];

		for (const track of sidecar.tracks) {
			const row = rowByFile.get(track.file);
			if (!row) {
				yield { kind: "track-error", file: track.file, error: "no catalog row for this file" };
				continue;
			}
			const effective = effectiveTagsForTrack(sidecar.album, track);
			try {
				let frontCoverArtPath: string | undefined;
				let isArtMissing = false;
				if (track.frontArt.trim()) {
					const artPath = join(dirname(row.path), track.frontArt.trim());
					if (await exists(artPath)) {
						frontCoverArtPath = artPath;
					} else {
						isArtMissing = true;
					}
				}
				const { artEmbedded } = await writeTags(row.path, effective, frontCoverArtPath);
				const mismatches = verifyWritten(effective, await readBackTags(row.path));
				await regenerateSingle(row, effective);
				results.push({ row, effective, mismatches });
				yield { kind: "track-ok", file: track.file, artEmbedded, artMissing: isArtMissing, mismatches };
			} catch (e) {
				results.push({ row, effective, mismatches: [], error: parseErrorMsg(e) });
				yield { kind: "track-error", file: track.file, error: parseErrorMsg(e) };
			}
		}

		const written = results.filter((r) => !r.error);
		// Apple-ready means the album passed validation and
		// every track was written and read back clean.
		// A genre warning does not flip it.
		// A missing genre does not break album grouping on the phone.
		const appleReady =
			validation.blocking.length === 0 &&
			sidecar.album.albumArtist.trim() !== "" &&
			results.length === sidecar.tracks.length &&
			written.length === results.length &&
			written.every((r) => r.mismatches.length === 0);

		for (const r of written) {
			recordTagged(db, r.row.path, {
				finalTags: toFinalTags(r.effective),
				appleReady,
				issues: [...validation.warnings, ...r.mismatches],
				albumSidecarPath: group.albumSidecarPath,
			});
		}

		yield {
			kind: "album-done",
			artist: group.artist,
			album: group.album,
			appleReady,
			ok: written.length,
			failed: results.length - written.length,
			warnings: validation.warnings,
		};
	}
}

function toFinalTags(t: EffectiveTags): FinalTags {
	return {
		albumArtist: t.albumartist,
		artist: t.artist,
		album: t.album,
		title: t.title,
		track: combineNumTotal(t.tracknumber, t.totaltracks),
		disc: combineNumTotal(t.discnumber, t.totaldiscs),
		date: t.date,
		genre: t.genre,
		compilation: t.compilation,
	};
}

function albumArtistChoicesFor(rows: FileRow[]): string[] {
	const out = new Set<string>();
	for (const r of rows) if (r.tagAlbumArtist?.trim()) out.add(r.tagAlbumArtist.trim());
	for (const r of rows) if (r.tagArtist?.trim()) out.add(r.tagArtist.trim());
	return [...out];
}
