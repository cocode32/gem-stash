import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Category } from "./classify.ts";

const exec = promisify(execFile);

/**
 * Canonical tag fields we care about.
 * Everything that maps to one of these is kept; everything else is logged as a dropped key so nothing is silently lost.
 * The set is deliberately close to the Apple-critical tag table plus a few common extras the owner may want to keep when hand-editing the sidecar.
 */
export type CanonicalTag =
	| "title"
	| "artist"
	| "album"
	| "albumartist"
	| "tracknumber"
	| "totaltracks"
	| "discnumber"
	| "totaldiscs"
	| "date"
	| "genre"
	| "compilation"
	| "composer"
	| "albumartistsort"
	| "artistsort"
	| "comment"
	| "grouping"
	| "isrc";

/**
 * Raw ffprobe/container key (already lowercased) -> canonical field.
 * Different containers spell the same idea differently (ID3 `album_artist`, Vorbis
 * `albumartist`, MP4 `aART` surfaced by ffprobe as `album_artist`), so we fold
 * the synonyms here rather than trusting the keys verbatim.
 */
const TAG_ALIASES: Record<string, CanonicalTag> = {
	title: "title",
	artist: "artist",
	album: "album",
	album_artist: "albumartist",
	albumartist: "albumartist",
	"album artist": "albumartist",
	track: "tracknumber",
	tracknumber: "tracknumber",
	trackno: "tracknumber",
	totaltracks: "totaltracks",
	tracktotal: "totaltracks",
	disc: "discnumber",
	discnumber: "discnumber",
	discno: "discnumber",
	totaldiscs: "totaldiscs",
	disctotal: "totaldiscs",
	date: "date",
	year: "date",
	genre: "genre",
	compilation: "compilation",
	tcmp: "compilation",
	composer: "composer",
	albumartistsort: "albumartistsort",
	album_artist_sort: "albumartistsort",
	artistsort: "artistsort",
	artist_sort: "artistsort",
	comment: "comment",
	grouping: "grouping",
	isrc: "isrc",
};

export type NormalizedTags = {
	tags: Partial<Record<CanonicalTag, string>>;
	/**
	 * Raw key -> raw value for everything that did not map.
	 * Kept so the owner can inspect and rescue anything the alias table missed.
	 */
	dropped: Record<string, string>;
};

export type ArtFile = {
	/**
	 * filename only (lives in the same directory as the audio file)
	 */
	file: string;
	source: "embedded";
	streamIndex: number;
	codec: string;
};

/**
 * The archive subfolder / catalog state the described file lives in.
 */
export type SidecarKind = Category;

/**
 * Order the scaffold is written in: Apple-critical tags first, then the extras.
 * Every canonical tag appears in the sidecar;
 * absent ones are empty strings so the file is a ready-to-edit template.
 * `pnpm tag` skips empties rather than writing a blank tag.
 */
const CANONICAL_TAG_ORDER: CanonicalTag[] = [
	"title",
	"artist",
	"albumartist",
	"album",
	"tracknumber",
	"totaltracks",
	"discnumber",
	"totaldiscs",
	"compilation",
	"date",
	"genre",
	"composer",
	"albumartistsort",
	"artistsort",
	"comment",
	"grouping",
	"isrc",
];

function scaffoldTags(found: Partial<Record<CanonicalTag, string>>): Record<CanonicalTag, string> {
	const out = {} as Record<CanonicalTag, string>;
	for (const tag of CANONICAL_TAG_ORDER) out[tag] = found[tag] ?? "";
	return out;
}

export type Sidecar = {
	schemaVersion: 1;
	source: {
		/**
		 * the file this sidecar describes (the kept archive/<kind>/ file)
		 */
		file: string;
		codec: string;
		kind: SidecarKind;
		/**
		 * basename of the file the tags/art were actually read from,
		 * when it differs from `file` (a converted FLAC reads from its untouched inbox source)
		 */
		tagsFrom?: string;
		extractedAt: string;
	};
	/**
	 * Full canonical scaffold: every tag present, empty string where unknown.
	 */
	tags: Record<CanonicalTag, string>;
	art: ArtFile[];
	droppedTags: Record<string, string>;
};

/**
 * 1. Read raw tags
 *
 * format_tags is the container-level metadata block.
 * We lowercase keys on the way out so the alias table only has to know one casing.
 *
 * @param path Path to the file
 */
export async function readRawTags(path: string): Promise<Record<string, string>> {
	try {
		const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", path], {
			maxBuffer: 4 * 1024 * 1024,
		});
		const data = JSON.parse(stdout);
		const raw = (data.format?.tags ?? {}) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = String(v);
		return out;
	} catch {
		return {};
	}
}

/**
 * 2. Normalize
 *
 * Fold the container-specific spellings of a field onto one canonical name, so
 * an ID3 `album_artist`, a Vorbis `albumartist` and an MP4 `aART` all land in
 * the same place.
 * @param raw The actual tags from the current media
 */
export function normalizeTags(raw: Record<string, string>): NormalizedTags {
	const tags: Partial<Record<CanonicalTag, string>> = {};
	const dropped: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		const canonical = TAG_ALIASES[key];
		if (canonical && value.trim().length > 0) {
			/*
			 * First writer wins, so a clean `albumartist` is not clobbered by a later synonym.
			 * In practice a file rarely carries two spellings of one field.
			 */
			if (tags[canonical] === undefined) {
				tags[canonical] = value;
			} else {
				dropped[key] = value;
			}
		} else {
			dropped[key] = value;
		}
	}
	return { tags, dropped };
}

const ART_EXT_BY_CODEC: Record<string, string> = {
	mjpeg: "jpg",
	jpeg: "jpg",
	jpg: "jpg",
	png: "png",
	bmp: "bmp",
	gif: "gif",
	webp: "webp",
};

type ArtStream = { vIndex: number; codec: string };

type ProbeStreamOutput = {
	codec_name?: string;
	disposition?: Record<string, number>;
};

/**
 * 3.1. Get art files from audio stream
 *
 * Enumerate the picture streams.
 * Audio files carry cover art as a video stream flagged attached_pic;
 * we also accept a bare image codec in case an older muxer did not set the flag.
 * @param path Path to the file to extract media from
 */
async function listArtStreams(path: string): Promise<ArtStream[]> {
	const { stdout } = await exec(
		"ffprobe",
		["-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_name,disposition", "-of", "json", path],
		{ maxBuffer: 4 * 1024 * 1024 },
	);
	const data = JSON.parse(stdout);
	const streams = (data.streams ?? []) as Array<ProbeStreamOutput>;
	const out: ArtStream[] = [];
	streams.forEach((s, vIndex) => {
		const codec = String(s.codec_name ?? "").toLowerCase();
		const attached = s.disposition?.attached_pic === 1;
		if (attached || codec in ART_EXT_BY_CODEC) out.push({ vIndex, codec });
	});
	return out;
}

/**
 * 3.2. Extract embedded art
 *
 * Reads embedded images from `sourcePath` and writes each into `destDir` as `<destBaseName>.art<N>.<ext>`.
 * Source and dest differ for converted FLACs:
 *   - the tags and art live in the untouched inbox source,
 *   - but the art file belongs next to the (tagless) archive FLAC.
 * Pure stream copy, never re-encodes.
 *
 * @param sourcePath The source file
 * @param destDir The destination file
 * @param destBaseName The base file name for the destination - used to alter/append ".art"
 */
export async function extractArt(sourcePath: string, destDir: string, destBaseName: string): Promise<ArtFile[]> {
	const streams = await listArtStreams(sourcePath);
	const art: ArtFile[] = [];
	for (let i = 0; i < streams.length; i++) {
		const { vIndex, codec } = streams[i];
		const ext = ART_EXT_BY_CODEC[codec] ?? "img";
		const file = `${destBaseName}.art${i}.${ext}`;
		const dest = join(destDir, file);
		await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-map", `0:v:${vIndex}`, "-c:v", "copy", dest]);
		art.push({ file, source: "embedded", streamIndex: vIndex, codec });
	}
	return art;
}

export function sidecarPathFor(audioPath: string): string {
	return `${audioPath}.sidecar.json`;
}

/**
 * 4. Creating the sidecar file
 *
 * @param audioPath The path to the media file
 * @param kind The type of media - `lossy` or `lossless`
 * @param codec The codec of the media file
 * @param normalized The normalized tags extracted from 2.
 * @param art The actual art file - contains the paths to the file stored on disk
 * @param tagsFrom The source of the tags
 */
export async function writeSidecar(
	audioPath: string,
	kind: SidecarKind,
	codec: string,
	normalized: NormalizedTags,
	art: ArtFile[],
	tagsFrom?: string,
): Promise<string> {
	const sidecar: Sidecar = {
		schemaVersion: 1,
		source: {
			file: basename(audioPath),
			codec,
			kind,
			...(tagsFrom && tagsFrom !== basename(audioPath) ? { tagsFrom } : {}),
			extractedAt: new Date().toISOString(),
		},
		tags: scaffoldTags(normalized.tags),
		art,
		droppedTags: normalized.dropped,
	};
	const out = sidecarPathFor(audioPath);
	await writeFile(out, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
	return out;
}

/**
 * Read a per-file sidecar back into the Sidecar shape.
 * Used by `pnpm scaffold` to consolidate the per-file sidecars into the album
 * master, and by `pnpm tag` to refresh the per-file sidecar from the master
 * after writing.
 *
 * @param path Path to the `<file>.sidecar.json`
 */
export async function readSidecar(path: string): Promise<Sidecar> {
	return JSON.parse(await readFile(path, "utf8")) as Sidecar;
}
