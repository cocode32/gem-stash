import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Category } from "./classify.ts";
import type { FileRow } from "./catalog.ts";
import type { CanonicalTag, NormalizedTags } from "./sidecar.ts";
import { normalizeTags, readRawTags, readSidecar, sidecarPathFor, writeSidecar } from "./sidecar.ts";
import { type EffectiveTags, splitNumTotal } from "./tagwrite.ts";
import { exists } from "../common/file.helpers.ts";

/**
 * Album-wide fields, uniform across every track by construction.
 * Putting them here is what makes a non-uniform album_artist structurally impossible
 * once the master exists, and makes a multi-disc release one document.
 */
export type AlbumCommon = {
	albumArtist: string;
	album: string;
	date: string;
	genre: string;
	compilation: string;
	totalTracks: string;
	totalDiscs: string;
	albumArtistSort: string;
};

export type AlbumTrack = {
	/**
	 * The file this track maps to, as a path relative to the archive root, e.g.
	 * "lossless/DJ Fresh/Fresh Goes Electro/1-01 Track.flac".
	 * The leading segment is the category, so a split album (some lossless, some lossy)
	 * still has every track addressable from the one master.
	 */
	file: string;
	title: string;
	artist: string;
	trackNumber: string;
	discNumber: string;
	composer: string;
	artistSort: string;
	comment: string;
	grouping: string;
	iSrc: string;
	/**
	 * Front-cover image filename (relative to the track file's directory)
	 * to embed; '' embeds nothing.
	 */
	frontArt: string;
};

/**
 * The single hand-edited document for a whole album: shared block + tracks.
 * Built by consolidating the per-file sidecars, then treated as the source of
 * truth the tag writer applies.
 * The per-file sidecars are regenerated from it.
 */
export type AlbumSidecar = {
	schemaVersion: 1;
	album: AlbumCommon;
	tracks: AlbumTrack[];
};

/**
 * All processed files of one album, and where the master lives.
 */
export type AlbumGroup = {
	/**
	 * albumArtistFolder, or '(root)' for files that sat at the inbox root.
	 */
	artist: string;
	album: string;
	rows: FileRow[];
	/**
	 * The category whose folder holds the master:
	 * lossless if any track is lossless,
	 * else lossy,
	 * else suspect.
	 */
	primaryCategory: Category;
	/**
	 * Absolute album folder of the primary category, where the master is written.
	 */
	albumDir: string;
	albumSidecarPath: string;
};

const ROOT = "(root)";
const CATEGORY_PRIORITY: Category[] = ["lossless", "lossy", "suspect"];

export function albumSidecarPathFor(albumDir: string): string {
	return join(albumDir, "album.sidecar.json");
}

/**
 * Group processed rows into albums by their (albumArtistFolder, albumFolder),
 * which come from the inbox layout and are identical across every track of an
 * album regardless of which category bucket it landed in.
 *
 * Split-album robust.
 *
 * @param rows Processed catalog rows (see findProcessed)
 */
export function groupProcessedAlbums(rows: FileRow[]): AlbumGroup[] {
	const byKey = new Map<string, FileRow[]>();
	for (const r of rows) {
		const key = `${r.albumArtistFolder ?? ROOT}\t${r.albumFolder ?? ROOT}`;
		const arr = byKey.get(key) ?? [];
		arr.push(r);
		byKey.set(key, arr);
	}

	const groups: AlbumGroup[] = [];
	for (const [key, items] of byKey) {
		const [artist, album] = key.split("\t");
		const { category, albumDir } = pickPrimary(items);
		groups.push({
			artist,
			album,
			rows: items,
			primaryCategory: category,
			albumDir,
			albumSidecarPath: albumSidecarPathFor(albumDir),
		});
	}
	groups.sort((a, b) => a.albumSidecarPath.localeCompare(b.albumSidecarPath));
	return groups;
}

function pickPrimary(rows: FileRow[]): { category: Category; albumDir: string } {
	for (const cat of CATEGORY_PRIORITY) {
		const row = rows.find((x) => x.state === cat);
		if (row) {
			return { category: cat, albumDir: dirname(row.path) };
		}
	}

	// No recognised state (shouldn't happen for processed rows); fall back.
	return { category: "lossless", albumDir: dirname(rows[0].path) };
}

type TrackTags = {
	tags: Partial<Record<CanonicalTag, string>>;
	art: string[];
};

/**
 * Read a row's tags + art filenames for consolidation:
 * - from its per-file sidecar when present,
 * - else straight off the file (an orphan dropped into the archive without a sidecar).
 */
async function readTrackTags(row: FileRow): Promise<TrackTags> {
	if (row.sidecarPath && (await exists(row.sidecarPath))) {
		const sidecar = await readSidecar(row.sidecarPath);
		return { tags: sidecar.tags, art: sidecar.art.map((a) => a.file) };
	}

	// if no sidecar is found, just normalize the metadata of the tags
	const norm = normalizeTags(await readRawTags(row.path));
	return { tags: norm.tags, art: [] };
}

/**
 * Build a draft album master by consolidating the per-file sidecars
 * (or raw file tags) of an album's rows.
 * Shared fields take the most common non-empty value found;
 * per-track fields come straight from each file.
 * The result is a hand-editable draft, not a final answer:
 * validation + the album_artist prompt, resolve anything ambiguous before tags are written.
 *
 * @param group The album to consolidate
 */
export async function consolidateAlbum(group: AlbumGroup): Promise<AlbumSidecar> {
	const tracks: AlbumTrack[] = [];
	const albumArtists: string[] = [];
	const albums: string[] = [];
	const dates: string[] = [];
	const genres: string[] = [];
	const compilations: string[] = [];
	const albumArtistSorts: string[] = [];
	const trackTotals: string[] = [];
	const discTotals: string[] = [];

	for (const row of group.rows) {
		const { tags, art } = await readTrackTags(row);
		const fullTrackNumber = splitNumTotal(tags.tracknumber ?? "");
		const fullDiskNumber = splitNumTotal(tags.discnumber ?? "");

		albumArtists.push(tags.albumartist ?? "");
		albums.push(tags.album ?? "");
		dates.push(tags.date ?? "");
		genres.push(tags.genre ?? "");
		compilations.push(tags.compilation ?? "");
		albumArtistSorts.push(tags.albumartistsort ?? "");
		trackTotals.push(fullTrackNumber.total || (tags.totaltracks ?? ""));
		discTotals.push(fullDiskNumber.total || (tags.totaldiscs ?? ""));

		tracks.push({
			file: row.relativePath,
			title: tags.title ?? "",
			artist: tags.artist ?? "",
			trackNumber: fullTrackNumber.num,
			discNumber: fullDiskNumber.num,
			composer: tags.composer ?? "",
			artistSort: tags.artistsort ?? "",
			comment: tags.comment ?? "",
			grouping: tags.grouping ?? "",
			iSrc: tags.isrc ?? "",
			frontArt: art[0] ?? "",
		});
	}

	const distinctDiscs = new Set(tracks.map((t) => t.discNumber).filter(Boolean));

	const album: AlbumCommon = {
		// album_artist is the one field we will not guess at.
		// Only fill it when the sources unanimously agree.
		// Any disagreement leaves it empty so the tag run prompts the owner for the canonical value
		// (typically the compiler/DJ, which is often not even one of the per-track artists).
		albumArtist: unanimous(albumArtists),
		album: modal(albums),
		date: modal(dates),
		genre: modal(genres),
		compilation: modal(compilations),
		totalTracks: modal(trackTotals) || (distinctDiscs.size <= 1 ? String(tracks.length) : ""),
		totalDiscs: modal(discTotals) || (distinctDiscs.size > 1 ? String(distinctDiscs.size) : ""),
		albumArtistSort: modal(albumArtistSorts),
	};

	return { schemaVersion: 1, album, tracks };
}

export async function readAlbumSidecar(path: string): Promise<AlbumSidecar> {
	return JSON.parse(await readFile(path, "utf8")) as AlbumSidecar;
}

export async function writeAlbumSidecar(path: string, sidecar: AlbumSidecar): Promise<void> {
	await writeFile(path, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}

/**
 * Merge the album's shared block onto a single track into the complete
 * canonical tag set the writer consumes. Album-level fields win for the shared
 * ones; per-track fields supply the rest.
 *
 * @param album The shared album block
 * @param track One track entry
 */
export function effectiveTagsForTrack(album: AlbumCommon, track: AlbumTrack): EffectiveTags {
	return {
		title: track.title,
		artist: track.artist,
		album: album.album,
		albumartist: album.albumArtist,
		tracknumber: track.trackNumber,
		totaltracks: album.totalTracks,
		discnumber: track.discNumber,
		totaldiscs: album.totalDiscs,
		date: album.date,
		genre: album.genre,
		compilation: album.compilation,
		composer: track.composer,
		albumartistsort: album.albumArtistSort,
		artistsort: track.artistSort,
		comment: track.comment,
		grouping: track.grouping,
		isrc: track.iSrc,
	};
}

/**
 * Refresh a track's per-file sidecar from the master after writing,
 * so the granular record stays in sync (the master is canonical; singles are derived).
 * - Read-modify-write when the per-file sidecar exists;
 * - Preserving its source + art + droppedTags;
 * - Create a fresh one when an orphan never had one.
 *
 * @param row The catalog row for the track
 * @param effective The effective tags written onto it
 */
export async function regenerateSingle(row: FileRow, effective: EffectiveTags): Promise<string> {
	const sidecarPath = sidecarPathFor(row.path);
	if (await exists(sidecarPath)) {
		const sidecar = await readSidecar(sidecarPath);
		sidecar.tags = effective;
		await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
		return sidecarPath;
	}
	const normalized: NormalizedTags = { tags: pickNonEmpty(effective), dropped: {} };
	return writeSidecar(row.path, row.state as Category, row.codec, normalized, []);
}

/**
 * Most common non-empty value;
 * ties resolve to the first one seen
 * (Map keeps insertion order).
 */
function modal(values: string[]): string {
	const counts = new Map<string, number>();
	for (const v of values) {
		const s = v.trim();
		if (!s) continue;
		counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	let best = "";
	let bestN = 0;
	for (const [v, n] of counts) {
		if (n > bestN) {
			best = v;
			// TODO check if we need bestN
			bestN = n;
		}
	}

	return best;
}

/**
 * The single distinct non-empty value if every source that has one agrees;
 * '' if there are zero or more than one distinct values.
 */
function unanimous(values: string[]): string {
	const distinct = new Set(values.map((v) => v.trim()).filter(Boolean));
	return distinct.size === 1 ? [...distinct][0] : "";
}

function pickNonEmpty(t: EffectiveTags): Partial<Record<CanonicalTag, string>> {
	const out: Partial<Record<CanonicalTag, string>> = {};
	for (const [k, v] of Object.entries(t)) {
		if (v) out[k as CanonicalTag] = v.trim();
	}
	return out;
}
