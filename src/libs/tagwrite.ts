// noinspection ExceptionCaughtLocallyJS -- expected behaviour where throws occur

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename } from "node:fs/promises";
import { extname } from "node:path";
import type { CanonicalTag } from "./sidecar.ts";
import { normalizeTags, readRawTags } from "./sidecar.ts";
import { safeUnlink } from "../common/file.helpers.ts";

const exec = promisify(execFile);

/**
 * A track's complete, merged tag set ready to write:
 * the album master's shared fields folded onto the per-track fields.
 * Every canonical field is present;
 * empty strings mean "do not write this tag" and the writers skip them.
 */
export type EffectiveTags = Record<CanonicalTag, string>;

/**
 * Canonical field -> Vorbis comment name (FLAC, via metaflac).
 */
const VORBIS_KEY: Partial<Record<CanonicalTag, string>> = {
	title: "TITLE",
	artist: "ARTIST",
	albumartist: "ALBUMARTIST",
	album: "ALBUM",
	date: "DATE",
	genre: "GENRE",
	compilation: "COMPILATION",
	composer: "COMPOSER",
	albumartistsort: "ALBUMARTISTSORT",
	artistsort: "ARTISTSORT",
	comment: "COMMENT",
	grouping: "GROUPING",
	isrc: "ISRC",
	tracknumber: "TRACKNUMBER",
	totaltracks: "TRACKTOTAL",
	discnumber: "DISCNUMBER",
	totaldiscs: "DISCTOTAL",
};

/**
 * Canonical field -> ffmpeg generic `-metadata` key.
 * The mp4/mp3 muxer maps these generic keys to the right atom/frame
 * (album_artist -> aART, compilation -> cpil, etc.), which is why we write generic keys
 * rather than trusting tags carried across transcodes.
 * - track/disc handled specially.
 * - isrc is left out: it has no reliable generic key and is not Apple-critical.
 */
const FFMETA_KEY: Partial<Record<CanonicalTag, string>> = {
	title: "title",
	artist: "artist",
	albumartist: "album_artist",
	album: "album",
	date: "date",
	genre: "genre",
	compilation: "compilation",
	composer: "composer",
	albumartistsort: "sort_album_artist",
	artistsort: "sort_artist",
	comment: "comment",
	grouping: "grouping",
};

/**
 * Containers we can embed a single front cover into without re-encoding audio.
 * FLAC via metaflac picture block; m4a/mp3 via an attached_pic video stream.
 * Everything else (ogg/opus/raw aac) gets tags only.
 */
const ART_EMBED_EXTS = new Set([".flac", ".m4a", ".mp3"]);

const VERIFY_EXACT_TAG_LIST: CanonicalTag[] = ["title", "artist", "albumartist", "album", "date", "genre"];
type CanonicalTagTrackNumberVerification = "tracknumber" | "discnumber";

export function canEmbedArt(filePath: string): boolean {
	return ART_EMBED_EXTS.has(extname(filePath).toLowerCase());
}

export type WriteResult = { artEmbedded: boolean };

/**
 * Write authoritative tags (and optionally embed a front cover) onto a file in place,
 * never touching the audio.
 * FLAC goes through metaflac (edits metadata blocks only, audio frames byte-identical);
 * every other container is a tag-rewriting `ffmpeg -c:a copy` remux to a sibling temp
 * that atomically replaces the original.
 *
 * @param filePath The archive file to tag
 * @param tags The merged effective tags for this track
 * @param frontArtPath Absolute path to the front cover image, or undefined
 */
export async function writeTags(filePath: string, tags: EffectiveTags, frontArtPath?: string): Promise<WriteResult> {
	const art = frontArtPath && canEmbedArt(filePath) ? frontArtPath : undefined;
	if (extname(filePath).toLowerCase() === ".flac") {
		await writeFlacTags(filePath, tags, art);
	} else {
		await writeContainerTags(filePath, tags, art);
	}
	return { artEmbedded: Boolean(art) };
}

function vorbisArgs(tag: EffectiveTags): string[] {
	const args: string[] = [];
	for (const [canon, key] of Object.entries(VORBIS_KEY)) {
		const vorbisValue = tag[canon as CanonicalTag];
		if (vorbisValue) args.push(`--set-tag=${key}=${vorbisValue.trim()}`);
	}
	return args;
}

/**
 * ### writeFlacTags
 * Operations apply left to right: clear existing tags + pictures
 * (idempotent on re-runs; the archive masters are stripped already),
 * then set + import.
 *
 * ## Metaflac docs
 *
 * ### Doc location online
 * https://xiph.org/flac/documentation_tools_metaflac.html
 *
 * ### Usage notes
 * Use metaflac to list, add, remove, or edit metadata in one or more FLAC files. You may perform one major operation, or many shorthand operations at a time.
 * Major operation list:
 * - --list
 * - --remove
 * - --block-number=#[,#[…]]
 * - --block-type=type[,type[…]]
 * - --except-block-type=type[,type[…]]
 * - --application-data-format=hexdump|text
 * - --data-format=binary|binary-headerless|text
 * - --append
 * - --remove-all
 * - --merge-padding
 * - --sort-padding
 */
async function writeFlacTags(filePath: string, t: EffectiveTags, frontArtPath: string | undefined): Promise<void> {
	// all "major operations" will be run first as separate items
	const majorOperationArgList = [["--remove", "--block-type=PICTURE"], ["--remove-all-tags"]];

	// run major operations
	for (const majorArgs of majorOperationArgList) {
		majorArgs.push(filePath);
		await exec("metaflac", majorArgs);
	}

	// run with minor args - can all be combined
	const minorArgs = [...vorbisArgs(t)];
	if (frontArtPath) {
		minorArgs.push(`--import-picture-from=3||||${frontArtPath}`);
	}
	minorArgs.push(filePath);
	await exec("metaflac", minorArgs);
}

function ffmpegMetaArgs(t: EffectiveTags): string[] {
	const args: string[] = [];
	for (const [canon, key] of Object.entries(FFMETA_KEY)) {
		const v = t[canon as CanonicalTag];
		if (v) {
			args.push("-metadata", `${key}=${v.trim()}`);
		}
	}
	const track = combineNumTotal(t.tracknumber, t.totaltracks);
	if (track) {
		args.push("-metadata", `track=${track}`);
	}
	const disc = combineNumTotal(t.discnumber, t.totaldiscs);
	if (disc) {
		args.push("-metadata", `disc=${disc}`);
	}
	return args;
}

async function writeContainerTags(filePath: string, t: EffectiveTags, frontArtPath: string | undefined): Promise<void> {
	const ext = extname(filePath);
	const tmp = `${filePath}.tagtmp${ext}`;
	await safeUnlink(tmp);

	const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", filePath];
	if (frontArtPath) {
		args.push("-i", frontArtPath);
	}
	// Map only the audio, dropping any existing metadata/art, then re-add ours.
	args.push("-map", "0:a");
	if (frontArtPath) {
		args.push("-map", "1:v");
	}
	args.push("-c:a", "copy");
	if (frontArtPath) {
		args.push("-c:v", "copy", "-disposition:v:0", "attached_pic");
	}
	args.push("-map_metadata", "-1", ...ffmpegMetaArgs(t), tmp);

	try {
		await exec("ffmpeg", args);
		await rename(tmp, filePath);
	} catch (e) {
		await safeUnlink(tmp);
		throw e;
	}
}

/**
 * Read tags back off a written file, normalized to canonical fields,
 * This allows the write operation to be confirmed against what was intended.
 * Reuses the same ffprobe + normalize path the sidecar extractor uses.
 *
 * @param filePath The file to re-probe
 */
export async function readBackTags(filePath: string): Promise<Partial<Record<CanonicalTag, string>>> {
	return normalizeTags(await readRawTags(filePath)).tags;
}

/**
 * Compare what we meant to write against what the file actually holds now.
 * Return a list of human-readable mismatches (empty means a clean write).
 *  - Only fields we intended to write are checked;
 *  - Track/disc compare the leading number so "1" and "1/18" both match;
 *  - Compilation is only enforced when we intended to set the flag.
 *
 * @param intended The effective tags we wrote
 * @param actual The normalized tags read back off the file
 */
export function verifyWritten(intended: EffectiveTags, actual: Partial<Record<CanonicalTag, string>>): string[] {
	const issues: string[] = [];

	const checkExact = (field: CanonicalTag) => {
		const want = intended[field].trim();
		if (!want) return;
		const got = (actual[field] ?? "").trim();
		if (got !== want) {
			issues.push(`${field}: expected "${want}", read "${got || "(none)"}"`);
		}
	};
	for (const field of VERIFY_EXACT_TAG_LIST) {
		checkExact(field);
	}

	const verifyTrackNumbers = (field: CanonicalTagTrackNumberVerification) => {
		const want = intended[field].trim();
		if (!want) return;
		const got = splitNumTotal(actual[field] ?? "").num;
		if (got !== want) issues.push(`${field}: expected "${want}", read "${got || "(none)"}"`);
	};
	verifyTrackNumbers("tracknumber");
	verifyTrackNumbers("discnumber");

	if (normBool(intended.compilation) === "1" && normBool(actual.compilation ?? "") !== "1") {
		issues.push(`compilation: expected 1, read "${actual.compilation ?? "(none)"}"`);
	}

	return issues;
}

/**
 * Split a "n/total" value (e.g. "1/18") into its parts. A bare number returns
 * an empty total. Handles both the FLAC convention (separate fields) and the
 * MP4 convention (combined) when reading back.
 */
export function splitNumTotal(v: string): { num: string; total: string } {
	const s = (v ?? "").trim();
	if (!s) return { num: "", total: "" };
	const i = s.indexOf("/");
	if (i === -1) return { num: s, total: "" };
	return { num: s.slice(0, i).trim(), total: s.slice(i + 1).trim() };
}

/**
 * Build the "n/total" form for ffmpeg's track/disc metadata. Returns '' when
 * there is no number, or just the number when there is no total.
 */
export function combineNumTotal(num: string, total: string): string {
	const n = (num ?? "").trim();
	if (!n) return "";
	const t = (total ?? "").trim();
	return t ? `${n}/${t}` : n;
}

function normBool(v: string): string {
	const s = (v ?? "").trim().toLowerCase();
	if (s === "1" || s === "true" || s === "yes") return "1";
	if (s === "0" || s === "false" || s === "no" || s === "") return "";
	return s;
}
