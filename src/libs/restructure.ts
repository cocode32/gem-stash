// noinspection ExceptionCaughtLocallyJS -- expected behaviour where throws occur

import { copyFile, mkdir, rename } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { findProcessed } from "./catalog.ts";
import {
	type AlbumCommon,
	type AlbumGroup,
	type AlbumSidecar,
	type AlbumTrack,
	effectiveTagsForTrack,
	groupProcessedAlbums,
	readAlbumSidecar,
} from "./album-sidecar.ts";
import { validateAlbum } from "./tag.ts";
import { readBackTags, verifyWritten, writeTags } from "./tagwrite.ts";
import { fullAudioHash, type OutputParanoia, type ParanoiaHashingAlgorithm, paranoiaOptions } from "./convert.ts";
import { albumRelPath } from "./layout.ts";
import { exists, safeUnlink } from "../common/file.helpers.ts";
import { parseErrorMsg } from "../common/format.helpers.ts";

/**
 * A planned album for the final-archive restructure. `ready` gates whether it is
 * placed; when false, `skipReason` says why (no master, blocking validation, or
 * an unresolved album artist).
 */
export type RestructurePlanAlbum = {
	group: AlbumGroup;
	sidecar: AlbumSidecar | null;
	ready: boolean;
	skipReason: string | null;
	/** lossless + lossy tracks that will be copied into the final archive. */
	placeable: number;
	/** tracks skipped (suspect, or no catalog row). */
	skippedTracks: number;
};

export type RestructureOptions = {
	/** absolute final_archive root the artist-first tree is written under. */
	finalRoot: string;
	/**
	 * Decoded-audio compare of the archive source vs the placed copy, proving the
	 * copy + tag-write left the audio untouched. null skips it (a copy plus a
	 * metadata-only tag write is audio-preserving by construction).
	 */
	paranoia: OutputParanoia;
	/** replace a file that already exists at the destination; off by default. */
	overwrite: boolean;
};

export type RestructureEvent =
	| { kind: "album-start"; artist: string; album: string; trackCount: number }
	| {
			kind: "track-ok";
			file: string;
			dest: string;
			artEmbedded: boolean;
			verifiedHash: string | null;
			mismatches: string[];
	  }
	| { kind: "track-skip"; file: string; note: string }
	| { kind: "track-error"; file: string; error: string }
	| {
			kind: "album-done";
			artist: string;
			album: string;
			placed: number;
			skipped: number;
			failed: number;
	  };

/**
 * Plan a restructure: group processed files into albums and, for each with a
 * master, decide whether it is ready and how many tracks are placeable
 * (lossless + lossy) vs skipped (suspect). No files are touched.
 *
 * @param db The catalog db
 */
export async function planRestructure(db: DatabaseSync): Promise<RestructurePlanAlbum[]> {
	const groups = groupProcessedAlbums(findProcessed(db));
	const plans: RestructurePlanAlbum[] = [];

	for (const group of groups) {
		if (!(await exists(group.albumSidecarPath))) {
			plans.push({
				group,
				sidecar: null,
				ready: false,
				skipReason: "no album master (run pnpm scaffold, then pnpm tag)",
				placeable: 0,
				skippedTracks: 0,
			});
			continue;
		}

		const sidecar = await readAlbumSidecar(group.albumSidecarPath);
		const validation = validateAlbum(sidecar);
		const rowByFile = new Map(group.rows.map((r) => [r.relativePath, r]));

		let placeable = 0;
		let skippedTracks = 0;
		for (const track of sidecar.tracks) {
			const state = rowByFile.get(track.file)?.state;
			if (state === "lossless" || state === "lossy") placeable++;
			else skippedTracks++; // suspect, or no row
		}

		let ready = true;
		let skipReason: string | null = null;
		if (validation.blocking.length > 0) {
			ready = false;
			skipReason = validation.blocking.join("; ");
		} else if (validation.needsAlbumArtist) {
			ready = false;
			skipReason = "album artist not set (run pnpm tag first)";
		} else if (placeable === 0) {
			ready = false;
			skipReason = "nothing placeable (only suspect tracks)";
		}

		plans.push({ group, sidecar, ready, skipReason, placeable, skippedTracks });
	}

	return plans;
}

/**
 * Copy every ready album's lossless + lossy files into the final archive under
 * an artist-first, tag-driven path, keeping each file's original format (no
 * transcode). Tags + front cover are re-applied from the master so the final
 * archive is correct regardless of whether `pnpm tag` ran on the staging
 * archive. The staging `archive/` tree is never modified.
 *
 * @param plans The planned albums (only `ready` ones are placed)
 * @param opts Final root, verification, overwrite
 */
export async function* executeRestructure(plans: RestructurePlanAlbum[], opts: RestructureOptions): AsyncGenerator<RestructureEvent> {
	for (const plan of plans) {
		if (!plan.ready || !plan.sidecar) continue;
		const { group, sidecar } = plan;

		yield {
			kind: "album-start",
			artist: sidecar.album.albumArtist,
			album: sidecar.album.album,
			trackCount: sidecar.tracks.length,
		};

		const rowByFile = new Map(group.rows.map((r) => [r.relativePath, r]));
		let placed = 0;
		let skipped = 0;
		let failed = 0;

		for (const track of sidecar.tracks) {
			const row = rowByFile.get(track.file);
			if (!row) {
				failed++;
				yield { kind: "track-error", file: track.file, error: "no catalog row for this file" };
				continue;
			}
			if (row.state !== "lossless" && row.state !== "lossy") {
				skipped++;
				yield {
					kind: "track-skip",
					file: track.file,
					note: `source is ${row.state} (suspect: review manually, not placed)`,
				};
				continue;
			}

			const ext = extname(row.path).slice(1).toLowerCase() || "bin";
			const dest = join(opts.finalRoot, albumRelPath(sidecar.album, track, ext));
			try {
				if (!opts.overwrite && (await exists(dest))) {
					skipped++;
					yield { kind: "track-skip", file: track.file, note: "destination exists (enable overwrite to replace)" };
					continue;
				}
				let verifyMode: ParanoiaHashingAlgorithm | null;
				if (opts.paranoia === paranoiaOptions.HashSHA256) {
					verifyMode = "sha256";
				} else if (opts.paranoia === paranoiaOptions.HashMD5) {
					verifyMode = "md5";
				} else {
					verifyMode = null;
				}
				const { artEmbedded, verifiedHash, mismatches } = await placeOne(row.path, dest, sidecar.album, track, verifyMode);
				placed++;
				yield { kind: "track-ok", file: track.file, dest, artEmbedded, verifiedHash, mismatches };
			} catch (e) {
				failed++;
				yield { kind: "track-error", file: track.file, error: parseErrorMsg(e) };
			}
		}

		yield {
			kind: "album-done",
			artist: sidecar.album.albumArtist,
			album: sidecar.album.album,
			placed,
			skipped,
			failed,
		};
	}
}

/**
 * Copy one archive file into the final archive at `dest`, keeping its format,
 * then re-apply the master's tags + front cover and (optionally) prove the audio
 * survived. Writes to a sibling temp and only reveals `dest` on success, so a
 * failed placement never leaves a half-written file at the final path.
 *
 * @param src Absolute path to the archive source file
 * @param dest Absolute destination path (same extension as src)
 * @param album The album master's shared block (tag source of truth)
 * @param track The track entry
 * @param verify Decoded-audio compare algorithm, or null to skip the check
 */
async function placeOne(
	src: string,
	dest: string,
	album: AlbumCommon,
	track: AlbumTrack,
	verify: ParanoiaHashingAlgorithm | null,
): Promise<{ artEmbedded: boolean; verifiedHash: string | null; mismatches: string[] }> {
	await mkdir(dirname(dest), { recursive: true });
	const tmp = `${dest}.tmp${extname(dest)}`;
	await safeUnlink(tmp);

	try {
		// 1. Byte-copy the archive file (no transcode, no re-encode).
		await copyFile(src, tmp);

		// 2. Re-apply the Apple-critical tags + front cover from the master.
		//    metaflac (FLAC) / ffmpeg -c:a copy (others): audio frames untouched.
		const effective = effectiveTagsForTrack(album, track);
		const artName = track.frontArt.trim();
		const artPath = artName ? join(dirname(src), artName) : undefined;
		const embedArt = artPath && (await exists(artPath)) ? artPath : undefined;
		const { artEmbedded } = await writeTags(tmp, effective, embedArt);

		// 3. Read the tags back to confirm they landed.
		const mismatches = verifyWritten(effective, await readBackTags(tmp));

		// 4. Optionally prove the audio is bit-identical to the archive source.
		let verifiedHash: string | null = null;
		if (verify) {
			const [srcHash, dstHash] = await Promise.all([fullAudioHash(src, verify), fullAudioHash(tmp, verify)]);
			if (!srcHash || srcHash !== dstHash) {
				throw new Error(`Final copy changed audio (${verify}) for ${src}: source ${srcHash} vs copy ${dstHash}`);
			}
			verifiedHash = dstHash;
		}

		// 5. Atomic reveal.
		await rename(tmp, dest);
		return { artEmbedded, verifiedHash, mismatches };
	} catch (e) {
		await safeUnlink(tmp);
		throw e;
	}
}
