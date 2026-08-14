import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { humanSize } from "../common/format.helpers.ts";
import { allRows, type FileRow } from "./catalog.ts";

export type ReportOptions = {
	/**
	 * If provided, only include rows whose `path` or `originalPath` is under one of these roots.
	 * If empty/undefined, include every row in the catalog.
	 */
	roots?: string[];
};

export type ReportOutput = {
	tracks: number;
	albums: number;
};

export type ReportAlbumGroups = {
	albums: number;
};

export async function generateReport(db: DatabaseSync, outPath: string, opts: ReportOptions = {}): Promise<ReportOutput> {
	let albumCount = 0;
	const rows = scopeRows(db, opts.roots);

	const unprocessed = rows.filter((r) => !r.state || r.state === "inbox");
	const lossless = rows.filter((r) => r.state === "lossless");
	const lossy = rows.filter((r) => r.state === "lossy");
	const suspect = rows.filter((r) => r.state === "suspect");
	// A processed source becomes safe to delete once its destination is verified,
	// regardless of which category bucket it landed in.
	const safeToDelete = rows.filter((r) => r.verified === 1 && r.originalPath);

	const verdictCounts: Record<string, number> = {
		"lossless-cd": 0,
		"lossless-hires": 0,
		lossy: 0,
		suspect: 0,
	};
	for (const r of rows) {
		verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
	}

	const out: string[] = [];
	out.push("# gem-stash Report");
	out.push("");
	out.push(`Generated: ${new Date().toISOString()}`);
	if (opts.roots && opts.roots.length > 0) {
		out.push("Roots:");
		for (const r of opts.roots) out.push(`- \`${r}\``);
	} else {
		out.push("Scope: entire catalog");
	}
	out.push("");

	out.push("## Summary");
	out.push("");
	out.push(`- Total tracked: ${rows.length}`);
	out.push(`- Unprocessed: ${unprocessed.length}`);
	out.push(`- In archive/lossless: ${lossless.length}`);
	out.push(`- In archive/lossy: ${lossy.length}`);
	out.push(`- In archive/suspect: ${suspect.length}`);
	out.push(`- Verified converts pending purge: ${safeToDelete.length}`);
	out.push("");
	out.push("By verdict:");
	out.push(`- lossless-cd: ${verdictCounts["lossless-cd"]}`);
	out.push(`- lossless-hires: ${verdictCounts["lossless-hires"]}`);
	out.push(`- lossy: ${verdictCounts.lossy}`);
	out.push(`- suspect: ${verdictCounts.suspect}`);
	out.push("");

	if (unprocessed.length > 0) {
		out.push("## Unprocessed");
		out.push("");
		albumCount += writeAlbumGroupedSection(out, unprocessed, { showVerified: false }).albums;
	}

	if (lossless.length > 0) {
		out.push("## Archive / lossless (FLAC masters)");
		out.push("");
		albumCount += writeAlbumGroupedSection(out, lossless, { showVerified: true }).albums;
	}

	if (lossy.length > 0) {
		out.push("## Archive / lossy (re-rip queue)");
		out.push("");
		albumCount += writeAlbumGroupedSection(out, lossy, { showVerified: false }).albums;
	}

	const whereSummary = out.indexOf("## Summary");
	out.splice(whereSummary + 3, 0, `- Albums (folders): ${albumCount}`);

	if (suspect.length > 0) {
		out.push("## Archive / suspect (manual review)");
		out.push("");
		out.push("| Path | Verdict | Codec | Channels | Sample rate | Bit depth |");
		out.push("|---|---|---|---|---|---|");
		for (const s of suspect) {
			out.push(
				`| ${cell(s.path)} | ${s.verdict} | ${cell(s.codec)} | ${s.channels ?? ""} | ${fmtRate(s.sampleRate)} | ${fmtBits(s.bitsPerChannel)} |`,
			);
		}
		out.push("");
	}

	if (safeToDelete.length > 0) {
		out.push("## Safe to delete (verified converts awaiting purge)");
		out.push("");
		out.push("These source files have been losslessly converted to FLAC and verified at the PCM sample level.");
		out.push("Run `pnpm purge` to delete after a final confirmation.");
		out.push("");
		for (const r of safeToDelete) {
			if (!r.originalPath) continue;
			const sz = await sizeOf(r.originalPath);
			out.push(`- \`${r.originalPath}\`${sz ? ` (${sz})` : " (missing)"}`);
		}
		out.push("");
	}

	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, out.join("\n"), "utf8");

	return { tracks: rows.length, albums: albumCount };
}

function scopeRows(db: DatabaseSync, roots: string[] | undefined): FileRow[] {
	if (!roots || roots.length === 0) {
		return allRows(db);
	}
	const clauses: string[] = [];
	const params: string[] = [];
	for (const r of roots) {
		clauses.push(`path LIKE ?`);
		params.push(`${r}%`);
		clauses.push(`originalPath LIKE ?`);
		params.push(`${r}%`);
	}
	const sql = `SELECT *
               FROM files
               WHERE ${clauses.join(" OR ")}
               ORDER BY path`;
	return db.prepare(sql).all(...params) as FileRow[];
}

function writeAlbumGroupedSection(out: string[], rows: FileRow[], opts: { showVerified: boolean }): ReportAlbumGroups {
	const groups = new Map<string, FileRow[]>();
	for (const r of rows) {
		const key = `${r.albumArtistFolder ?? "(root)"}\t${r.albumFolder ?? "(root)"}`;
		const arr = groups.get(key) ?? [];
		arr.push(r);
		groups.set(key, arr);
	}
	const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

	for (const [key, items] of sorted) {
		const [artistFolder, albumFolder] = key.split("\t");
		out.push(`### ${artistFolder} / ${albumFolder}`);
		out.push("");

		const albumArtists = new Set(items.map((i) => i.tagAlbumArtist).filter((v): v is string => !!v));
		const artists = new Set(items.map((i) => i.tagArtist).filter((v): v is string => !!v));
		const compilationFlags = new Set(items.map((i) => i.tagCompilation).filter((v): v is string => v !== null));
		const verdicts = new Set(items.map((i) => i.verdict));

		const flags: string[] = [];
		if (items.every((i) => !i.tagAlbumArtist)) {
			flags.push("Missing albumartist tag on all tracks.");
		} else if (albumArtists.size > 1) {
			flags.push(
				`CRITICAL: mixed albumartist across tracks: ${[...albumArtists]
					.map((a) => `"${a}"`)
					.join(", ")}. Apple Music will split this album.`,
			);
		}
		if (artists.size > 1 && albumArtists.size === 1) {
			const hasCompilation = compilationFlags.has("1") || compilationFlags.has("true");
			if (!hasCompilation) {
				flags.push("CRITICAL: looks like a compilation (varied artist, uniform albumartist) but compilation flag is not set.");
			}
		}
		if (verdicts.size > 1) {
			flags.push(`Mixed quality verdicts in album: ${[...verdicts].join(", ")}.`);
		}

		if (flags.length > 0) {
			out.push("Flags:");
			for (const f of flags) out.push(`- ${f}`);
			out.push("");
		}

		const headerCols = ["Track", "Verdict", "Codec", "Sample rate", "Bit depth", "Bit rate", "Duration"];
		if (opts.showVerified) headerCols.push("Verified");
		headerCols.push("Artist", "Album artist");

		out.push(`| ${headerCols.join(" | ")} |`);
		out.push(`|${headerCols.map(() => "---").join("|")}|`);

		for (const i of items) {
			const cols = [
				cell(i.filename),
				i.verdict,
				cell(i.codec),
				fmtRate(i.sampleRate),
				fmtBits(i.bitsPerChannel),
				fmtBitRate(i.bitRate),
				fmtDuration(i.durationSeconds),
			];
			if (opts.showVerified) cols.push(i.verified === 1 ? "yes" : "");
			cols.push(cell(i.tagArtist), cell(i.tagAlbumArtist));
			out.push(`| ${cols.join(" | ")} |`);
		}
		out.push("");
	}

	return { albums: groups.size };
}

function cell(v: string | null | undefined): string {
	if (!v) return "";
	return v.replace(/\|/g, "\\|");
}

function fmtRate(hz: number | null): string {
	if (!hz) return "";
	return `${(hz / 1000).toFixed(1)} kHz`;
}

function fmtBits(b: number | null): string {
	if (b === null || b === undefined) return "";
	return `${b}-bit`;
}

function fmtBitRate(br: number | null): string {
	if (!br) return "";
	return `${Math.round(br / 1000)} kbps`;
}

function fmtDuration(s: number | null): string {
	if (!s) return "";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

async function sizeOf(path: string): Promise<string | null> {
	try {
		const s = await stat(path);
		return humanSize(s.size);
	} catch {
		return null;
	}
}
