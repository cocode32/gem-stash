import { readdir } from "node:fs/promises";
import { join, extname, relative, basename, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { inspect } from "./inspect.ts";
import { classify, type Verdict } from "./classify.ts";
import { findByPath, upsertFile, type FileRow } from "./catalog.ts";
import { AUDIO_EXTENSIONS } from "../common/constants.ts";

export type EnsureResult = { row: FileRow; cached: boolean };

//
/**
 * Single source of truth for "inspect this file once and persist it".
 * If the catalog already has a row for this path we return it untouched;
 * otherwise we run ffprobe via inspect(), classify, and upsert.
 * Both `pnpm scan` and the inbox planner share this so we never inspect the same path twice.
 *
 * @param db The catalog db
 * @param srcPath The path to the file we want to scan
 * @param root The inbox root
 */
export async function ensureFileScanned(db: DatabaseSync, srcPath: string, root: string): Promise<EnsureResult> {
	const existing = findByPath(db, srcPath);
	if (existing) return { row: existing, cached: true };

	const result = await inspect(srcPath);
	const verdict = classify(result.stream);
	const rel = relative(root, srcPath);

	const row: FileRow = {
		path: srcPath,
		relativePath: rel,
		albumArtistFolder: deriveAlbumArtistFolder(rel),
		albumFolder: deriveAlbumFolder(rel),
		filename: basename(srcPath),
		codec: result.stream.codec,
		channels: result.stream.channels,
		sampleRate: result.stream.sampleRate,
		bitsPerChannel: result.stream.bitsPerChannel,
		bitRate: result.stream.bitRate,
		durationSeconds: result.stream.durationSeconds,
		verdict,
		inspector: result.stream.inspector,
		tagAlbumArtist: result.tags.albumArtist ?? null,
		tagArtist: result.tags.artist ?? null,
		tagAlbum: result.tags.album ?? null,
		tagTitle: result.tags.title ?? null,
		tagTrack: result.tags.track ?? null,
		tagDisc: result.tags.disc ?? null,
		tagDate: result.tags.date ?? null,
		tagGenre: result.tags.genre ?? null,
		tagCompilation: result.tags.compilation ?? null,
		scannedAt: new Date().toISOString(),
		error: null,
		// Pipeline-state columns: null until process/extract touches the row.
		state: null,
		originalPath: null,
		verified: null,
		verifyMd5Source: null,
		verifyMd5Dest: null,
		verifyAudioMd5: null,
		verifyAudioSha256: null,
		processedAt: null,
		sidecarPath: null,
		artPaths: null,
		droppedTagKeys: null,
		tagsExtractedAt: null,
		detaggedAt: null,
		appleReady: null,
		taggedAt: null,
		tagIssues: null,
		albumSidecarPath: null,
	};

	upsertFile(db, row);
	return { row, cached: false };
}

export type ScanEvent =
	| {
			kind: "file";
			path: string;
			verdict: Verdict;
			codec: string;
			inspector: string;
	  }
	| { kind: "cached"; path: string; verdict: Verdict; codec: string }
	| { kind: "error"; path: string; error: string }
	| {
			kind: "done";
			total: number;
			fresh: number;
			cached: number;
			errors: number;
	  };

export async function* scan(root: string, db: DatabaseSync): AsyncGenerator<ScanEvent> {
	const files = await walk(root);
	let fresh = 0;
	let cached = 0;
	let errors = 0;

	for (const path of files) {
		try {
			const result = await ensureFileScanned(db, path, root);
			if (result.cached) {
				cached++;
				yield {
					kind: "cached",
					path,
					verdict: result.row.verdict,
					codec: result.row.codec,
				};
			} else {
				fresh++;
				yield {
					kind: "file",
					path,
					verdict: result.row.verdict,
					codec: result.row.codec,
					inspector: result.row.inspector,
				};
			}
		} catch (e) {
			errors++;
			const msg = e instanceof Error ? e.message : String(e);
			yield { kind: "error", path, error: msg };
		}
	}

	yield { kind: "done", total: files.length, fresh, cached, errors };
}

export async function walk(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const result: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const ext = extname(entry.name).toLowerCase();
		if (!AUDIO_EXTENSIONS.has(ext)) continue;
		result.push(join(entry.parentPath, entry.name));
	}
	result.sort();
	return result;
}

export function deriveAlbumArtistFolder(rel: string): string | null {
	const parts = rel.split(sep);
	return parts.length >= 2 ? parts[0] : null;
}

export function deriveAlbumFolder(rel: string): string | null {
	const parts = rel.split(sep);
	return parts.length >= 3 ? parts[1] : null;
}
