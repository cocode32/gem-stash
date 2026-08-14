// noinspection ExceptionCaughtLocallyJS -- expected behaviour where throws occur

import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { exists } from "../common/file.helpers.ts";
import { type ConversionHashes, findByOriginalPath, recordExtraction, recordProcessed } from "./catalog.ts";
import { type Category, categoryFor, type Verdict } from "./classify.ts";
import { encodeToFlacWithVerify, type Paranoia, remuxStripTo } from "./convert.ts";
import { ensureFileScanned, walk } from "./scan.ts";
import { extractArt, normalizeTags, readRawTags, writeSidecar } from "./sidecar.ts";

export type Action = "encode-to-flac" | "copy-strip" | "skip-already-processed" | "skip-dest-exists";

export type PlanItem = {
	srcPath: string;
	relativeSubpath: string;
	destPath: string | null;
	destRelative: string | null;
	verdict: Verdict;
	category: Category;
	codec: string;
	bitsPerChannel: number | null;
	sampleRate: number | null;
	bitRate: number | null;
	durationSeconds: number | null;
	sizeBytes: number;
	action: Action;
	note?: string;
};

export type Roots = {
	inbox: string;
	/**
	 * The single archive root.
	 * Processed files land under archive/<category>/.
	 */
	archive: string;
};

export async function planInbox(db: DatabaseSync, roots: Roots): Promise<PlanItem[]> {
	const files = await walk(roots.inbox);
	const items: PlanItem[] = [];

	for (const srcPath of files) {
		const rel = relative(roots.inbox, srcPath);
		const sizeBytes = (await stat(srcPath)).size;

		// Sources that were already processed in a prior run and are sitting here
		// verified, waiting for an explicit purge.
		// The row's path now points at the destination; originalPath still points back here.
		const existing = findByOriginalPath(db, srcPath);
		if (existing && existing.verified === 1) {
			items.push({
				srcPath,
				relativeSubpath: rel,
				destPath: null,
				destRelative: null,
				verdict: (existing.verdict as Verdict) ?? "suspect",
				category: categoryFor((existing.verdict as Verdict) ?? "suspect"),
				codec: existing.codec ?? "",
				bitsPerChannel: existing.bitsPerChannel,
				sampleRate: existing.sampleRate,
				bitRate: existing.bitRate,
				durationSeconds: existing.durationSeconds,
				sizeBytes,
				action: "skip-already-processed",
				note: "already processed; awaiting purge",
			});
			continue;
		}

		// ensureFileScanned is the shared cache layer with scan.ts:
		// if the row already exists for this path, no ffprobe call happens;
		// we just read verdict/codec/etc out of the catalog.
		const { row } = await ensureFileScanned(db, srcPath, roots.inbox);
		const verdict = row.verdict;
		const codec = row.codec;
		const category = categoryFor(verdict);

		const base = {
			srcPath,
			relativeSubpath: rel,
			verdict,
			category,
			codec,
			bitsPerChannel: row.bitsPerChannel,
			sampleRate: row.sampleRate,
			bitRate: row.bitRate,
			durationSeconds: row.durationSeconds,
			sizeBytes,
		};

		// Lossless non-FLAC is the only case that re-encodes (to a FLAC master).
		// Everything else (FLAC masters, lossy, suspect) is a tag/art-stripping
		// remux copy that preserves the original audio bitstream and container.
		const isEncode = category === "lossless" && codec !== "flac";
		const subpath = isEncode ? swapExt(rel, ".flac") : rel;
		const destRel = join(category, subpath);
		const destPath = join(roots.archive, destRel);
		items.push({
			...base,
			destPath,
			destRelative: destRel,
			action: (await exists(destPath)) ? "skip-dest-exists" : isEncode ? "encode-to-flac" : "copy-strip",
		});
	}

	return items;
}

export type ProcessEvent =
	| {
			kind: "ok";
			action: Action;
			srcPath: string;
			destPath: string | null;
			md5?: string;
			sha256?: string;
			artCount: number;
			droppedCount: number;
	  }
	| { kind: "skip"; action: Action; srcPath: string; note: string }
	| { kind: "error"; action: Action; srcPath: string; error: string };

export async function* executePlan(db: DatabaseSync, items: PlanItem[], paranoia: Paranoia): AsyncGenerator<ProcessEvent> {
	for (const item of items) {
		try {
			switch (item.action) {
				case "skip-already-processed":
				case "skip-dest-exists": {
					yield {
						kind: "skip",
						action: item.action,
						srcPath: item.srcPath,
						note: item.note ?? item.action,
					};
					break;
				}
				case "encode-to-flac":
				case "copy-strip": {
					if (!item.destPath) {
						throw new Error("destination path required, but not declared.");
					}
					if (!item.destRelative) {
						throw new Error("destination relative path required, but not declared.");
					}
					const destPath = item.destPath;
					const destDir = dirname(destPath);
					const destBase = basename(destPath);
					await mkdir(destDir, { recursive: true });

					// Extract metadata + art from the untouched inbox source FIRST, so they
					// are safe on disk next to the destination before the (potentially failing) encode/strip runs.
					// A converted FLAC is tagless, so the source is the only place its tags live.
					const raw = await readRawTags(item.srcPath);
					const normalized = normalizeTags(raw);
					const art = await extractArt(item.srcPath, destDir, destBase);
					const sidecarPath = await writeSidecar(destPath, item.category, item.codec, normalized, art, basename(item.srcPath));

					// Produce the stripped destination. The inbox source is never touched.
					let hashes: ConversionHashes;
					if (item.action === "encode-to-flac") {
						const r = await encodeToFlacWithVerify(db, item.srcPath, destPath, paranoia);
						hashes = {
							streamInfoMd5: r.streamInfoMd5,
							audioMd5: r.audioMd5,
							audioSha256: r.audioSha256,
						};
					} else if (item.action === "copy-strip") {
						const r = await remuxStripTo(item.srcPath, destPath, paranoia);
						hashes = { streamInfoMd5: null, audioMd5: r.audioMd5, audioSha256: r.audioSha256 };
					} else {
						throw new Error("Unknown action; we cannot continue since this action has no logic to handle");
					}

					// verified gates the safe-to-delete worklist.
					// Reaching here means the destination was produced:
					// at every paranoia >= Verify the encode/remux already threw on any mismatch,
					// and at Paranoia.None we trust the copy without checks
					// (running with no paranoia assumes everything went fine).
					// Either way the inbox source is now safe to delete.
					recordProcessed(db, item.srcPath, destPath, item.destRelative, item.category, true, hashes);
					recordExtraction(db, destPath, {
						sidecarPath,
						artFiles: art.map((a) => a.file),
						droppedKeys: Object.keys(normalized.dropped),
						detagged: true,
					});

					yield {
						kind: "ok",
						action: item.action,
						srcPath: item.srcPath,
						destPath,
						md5: hashes.audioMd5 ?? hashes.streamInfoMd5 ?? undefined,
						sha256: hashes.audioSha256 ?? undefined,
						artCount: art.length,
						droppedCount: Object.keys(normalized.dropped).length,
					};
					break;
				}
				default:
					throw new Error("Unknown action; we cannot continue since this action has no logic to handle");
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			yield {
				kind: "error",
				action: item.action,
				srcPath: item.srcPath,
				error: msg,
			};
		}
	}
}

function swapExt(p: string, newExt: string): string {
	const ext = extname(p);
	return ext ? p.slice(0, -ext.length) + newExt : p + newExt;
}

export function summarizePlan(items: PlanItem[]): {
	byAction: Record<Action, number>;
	totalBytes: number;
} {
	const byAction: Record<Action, number> = {
		"encode-to-flac": 0,
		"copy-strip": 0,
		"skip-already-processed": 0,
		"skip-dest-exists": 0,
	};
	let totalBytes = 0;
	for (const it of items) {
		byAction[it.action]++;
		totalBytes += it.sizeBytes;
	}
	return { byAction, totalBytes };
}
