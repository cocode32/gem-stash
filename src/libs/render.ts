// noinspection ExceptionCaughtLocallyJS -- expected behaviour where throws occur

import { execFile } from "node:child_process";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { exists, safeUnlink } from "../common/file.helpers.ts";
import { parseErrorMsg } from "../common/format.helpers.ts";
import {
	type AlbumCommon,
	type AlbumGroup,
	type AlbumSidecar,
	type AlbumTrack,
	effectiveTagsForTrack,
	groupProcessedAlbums,
	readAlbumSidecar,
} from "./album-sidecar.ts";
import { type FileRow, findProcessed } from "./catalog.ts";
import { fullAudioHash, type OutputParanoia, type ParanoiaHashingAlgorithm, paranoiaOptions } from "./convert.ts";
import { validateAlbum } from "./tag.ts";
import { readBackTags, verifyWritten, writeTags } from "./tagwrite.ts";

const exec = promisify(execFile);

/**
 * A planned album for the Apple render.
 * `ready` gates whether it will render; when false, `skipReason` says why
 * (no master, blocking validation issues, unresolved album artist, etc.).
 */
export type RenderPlanAlbum = {
	group: AlbumGroup;
	sidecar: AlbumSidecar | null;
	ready: boolean;
	skipReason: string | null;
	/**
	 * Tracks that render as lossless ALAC
	 * (FLAC master source).
	 */
	losslessTracks: number;
	/**
	 * Tracks that render as AAC
	 * (the lossy queue: copied if already AAC, else re-encoded).
	 */
	lossyTracks: number;
	/**
	 * Tracks not rendered
	 * (suspect, or no catalog row).
	 */
	skippedTracks: number;
};

/**
 * How a track's source becomes a m4a file:
 * - alac: a lossless FLAC master -> ALAC (bit-identical).
 * - aac-copy: a lossy source that is already AAC -> copied as-is (no extra loss).
 * - aac-encode: a lossy source in another codec (mp3/ogg/...) -> AAC 256k,
 *   one unavoidable re-encode.
 *   For re-rip-queue tracks the owner wants on the phone but has no disc to re-rip.
 */
export type RenderMode = "alac" | "aac-copy" | "aac-encode";

/**
 * Pick the render mode from a track's catalog row: FLAC masters go lossless,
 * an AAC lossy source is preserved by copy, any other lossy source is re-encoded.
 */
function renderModeFor(row: FileRow): RenderMode {
	if (row.state === "lossless") return "alac";
	return row.codec === "aac" ? "aac-copy" : "aac-encode";
}

export type RenderOptions = {
	/**
	 * Absolute `renders/apple` root the artist-first tree is written under.
	 */
	renderRoot: string;
	/**
	 * Decoded-audio compare of master vs render to prove the ALAC transcode is bit-identical.
	 * null skips the check (trusts ALAC's losslessness).
	 */
	paranoia: OutputParanoia;
	/**
	 * Replace a render that already exists;
	 * off by default (skip instead).
	 */
	overwrite: boolean;
};

export type RenderEvent =
	| { kind: "album-start"; artist: string; album: string; trackCount: number }
	| {
			kind: "track-ok";
			file: string;
			dest: string;
			mode: RenderMode;
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
			rendered: number;
			skipped: number;
			failed: number;
	  };

/**
 * Plan an Apple render. Groups every processed file into albums and, for each
 * album that has a master, decides whether it is ready to render and how its
 * tracks split across lossless (ALAC), lossy (AAC) and skipped (suspect).
 *
 * No files are touched.
 *
 * @param db The catalog db
 */
export async function planRender(db: DatabaseSync): Promise<RenderPlanAlbum[]> {
	const groups = groupProcessedAlbums(findProcessed(db));
	const plans: RenderPlanAlbum[] = [];

	for (const group of groups) {
		if (!(await exists(group.albumSidecarPath))) {
			plans.push({
				group,
				sidecar: null,
				ready: false,
				skipReason: "no album master (run pnpm scaffold, then pnpm tag)",
				losslessTracks: 0,
				lossyTracks: 0,
				skippedTracks: 0,
			});
			continue;
		}

		const sidecar = await readAlbumSidecar(group.albumSidecarPath);
		const validation = validateAlbum(sidecar);
		const rowByFile = new Map(group.rows.map((r) => [r.relativePath, r]));

		let losslessTracks = 0;
		let lossyTracks = 0;
		let skippedTracks = 0;
		for (const track of sidecar.tracks) {
			const state = rowByFile.get(track.file)?.state;
			if (state === "lossless") losslessTracks++;
			else if (state === "lossy") lossyTracks++;
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
		} else if (losslessTracks + lossyTracks === 0) {
			ready = false;
			skipReason = "nothing renderable (only suspect tracks)";
		}

		plans.push({ group, sidecar, ready, skipReason, losslessTracks, lossyTracks, skippedTracks });
	}

	return plans;
}

/**
 * Execute the render for every ready album.
 *
 * Per track:
 * - transcode the FLAC master to ALAC m4a,
 * - optionally prove it decodes bit-identical,
 * - re-write the Apple-critical tags + front cover from the master,
 * - read them back to confirm, and
 * - atomically reveal the file.
 *
 * Suspect tracks are skipped (they belong on the re-rip queue).
 * Nothing in archive/ is touched; renders are disposable and are not recorded in the catalog.
 *
 * @param plans The planned albums (only `ready` ones render)
 * @param opts Render root, verification, overwrite
 */
export async function* executeRender(plans: RenderPlanAlbum[], opts: RenderOptions): AsyncGenerator<RenderEvent> {
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
		let rendered = 0;
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
					note: `source is ${row.state} (suspect: review manually, not rendered)`,
				};
				continue;
			}

			const dest = join(opts.renderRoot, renderRelPath(sidecar.album, track));
			try {
				if (!opts.overwrite && (await exists(dest))) {
					skipped++;
					yield { kind: "track-skip", file: track.file, note: "render exists (enable overwrite to replace)" };
					continue;
				}
				const mode = renderModeFor(row);
				let verifyMode: ParanoiaHashingAlgorithm | null;
				if (opts.paranoia === paranoiaOptions.HashSHA256) {
					verifyMode = "sha256";
				} else if (opts.paranoia === paranoiaOptions.HashMD5) {
					verifyMode = "md5";
				} else {
					verifyMode = null;
				}
				const { artEmbedded, verifiedHash, mismatches } = await renderOne(row.path, dest, sidecar.album, track, mode, verifyMode);
				rendered++;
				yield { kind: "track-ok", file: track.file, dest, mode, artEmbedded, verifiedHash, mismatches };
			} catch (e) {
				failed++;
				yield { kind: "track-error", file: track.file, error: parseErrorMsg(e) };
			}
		}

		yield {
			kind: "album-done",
			artist: sidecar.album.albumArtist,
			album: sidecar.album.album,
			rendered,
			skipped,
			failed,
		};
	}
}

/**
 * Render one FLAC master to a tagged ALAC m4a at `dest`.
 * Writes to a sibling temp and only reveals `dest` after the transcode is
 * (optionally) proven lossless and the tags are written + read back, so a
 * failed render never leaves a half-baked file at the final path.
 *
 * @param src Absolute path to the source (FLAC master, or a lossy queue file)
 * @param dest Absolute destination m4a path
 * @param album The album master's shared block (tag source of truth)
 * @param track The track entry
 * @param mode How to produce the m4a (alac / aac-copy / aac-encode)
 * @param verify Decoded-audio compare algorithm, or null to skip the check
 */
async function renderOne(
	src: string,
	dest: string,
	album: AlbumCommon,
	track: AlbumTrack,
	mode: RenderMode,
	verify: ParanoiaHashingAlgorithm | null,
): Promise<{ artEmbedded: boolean; verifiedHash: string | null; mismatches: string[] }> {
	await mkdir(dirname(dest), { recursive: true });
	const tmp = `${dest}.tmp.m4a`;
	await safeUnlink(tmp);

	try {
		// 1. Produce the tagless m4a from the source:
		//    - alac:       FLAC master -> ALAC (lossless, bit-identical)
		//    - aac-copy:   already-AAC lossy source -> copy the bitstream (no extra loss)
		//    - aac-encode: other lossy source -> AAC 256k (one unavoidable generation)
		const audioArgs = mode === "alac" ? ["-c:a", "alac"] : mode === "aac-copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "256k"];
		await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:a", "-map_metadata", "-1", ...audioArgs, tmp]);

		// 2. Prove the render decodes bit-identical to the source,
		//    but only where the audio is preserved (an ALAC transcode or an AAC copy).
		//    A lossy re-encode (aac-encode) changes the samples by design, so there is nothing to prove.
		let verifiedHash: string | null = null;
		if (verify && mode !== "aac-encode") {
			const [srcHash, dstHash] = await Promise.all([fullAudioHash(src, verify), fullAudioHash(tmp, verify)]);
			if (!srcHash || srcHash !== dstHash) {
				throw new Error(`Render not bit-identical (${verify}) for ${src}: source ${srcHash} vs render ${dstHash}`);
			}
			verifiedHash = dstHash;
		}

		// 3. Re-apply the Apple-critical tags + front cover from the master.
		//    writeTags remuxes -c:a copy (the m4a audio bitstream is byte-copied).
		const effective = effectiveTagsForTrack(album, track);
		const artName = track.frontArt.trim();
		const artPath = artName ? join(dirname(src), artName) : undefined;
		const embedArt = artPath && (await exists(artPath)) ? artPath : undefined;
		const { artEmbedded } = await writeTags(tmp, effective, embedArt);

		// 4. Read back to confirm the tags landed.
		const mismatches = verifyWritten(effective, await readBackTags(tmp));

		// 5. Atomic reveal.
		await rename(tmp, dest);
		return { artEmbedded, verifiedHash, mismatches };
	} catch (e) {
		await safeUnlink(tmp);
		throw e;
	}
}

/**
 * Build the artist-first relative path for a render from the master tags
 * (not the archive layout), so a split album still lands in one folder:
 *   - <AlbumArtist>/<Album>/<D-TT> <Title>.m4a
 */
export function renderRelPath(album: AlbumCommon, track: AlbumTrack): string {
	const artist = sanitizeSegment(album.albumArtist) || "Unknown Artist";
	const albumName = sanitizeSegment(album.album) || "Unknown Album";
	const disc = track.discNumber.trim() || "1";
	const num = pad2(track.trackNumber.trim());
	const title = sanitizeSegment(track.title) || "Untitled";
	return join(artist, albumName, `${disc}-${num} ${title}.m4a`);
}

function pad2(n: string): string {
	const i = parseInt(n, 10);
	return Number.isFinite(i) ? String(i).padStart(2, "0") : n || "00";
}

/**
 * Strip characters that are illegal or troublesome in filenames on macOS and on FAT (the future car USB):
 * - path separators,
 * - the reserved Windows set,
 * - control chars, and
 * - trailing dots/spaces
 */
function sanitizeSegment(s: string): string {
	return (
		s
			// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit control characters used as part of sanitizing the input
			.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
			.replace(/\s+/g, " ")
			.replace(/[. ]+$/g, "")
			.trim()
	);
}
