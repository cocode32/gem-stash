import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { exists } from "../common/file.helpers.ts";
import { humanSize } from "../common/format.helpers.ts";
import { findVerifiedSafeToDelete, openCatalog } from "../libs/catalog.ts";
import { type Paranoia, ParanoiaFriendlyNameMap, paranoiaOptions } from "../libs/convert.ts";
import { type Action, executePlan, type PlanItem, planInbox, type Roots, summarizePlan } from "../libs/process.ts";
import { generateReport } from "../libs/report.ts";

async function main(): Promise<void> {
	p.intro("gem-stash process");

	const workRoot = await p.text({
		message: "Work root (contains inbox/ and archive/)",
		initialValue: "./work",
		validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
	});
	if (p.isCancel(workRoot)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}
	const work = resolve(String(workRoot));

	const inboxSubdir = await p.text({
		message: "Inbox subdir to process (relative to work/inbox; leave empty for the whole inbox)",
		placeholder: "sample",
		initialValue: "",
	});
	if (p.isCancel(inboxSubdir)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const inbox = String(inboxSubdir).trim().length > 0 ? join(work, "inbox", String(inboxSubdir).trim()) : join(work, "inbox");
	// Single archive root; processed files land under archive/<category>/.
	const archive = join(work, "archive");

	if (!(await isDir(inbox))) {
		p.cancel(`Inbox path does not exist or is not a directory: ${inbox}`);
		process.exit(1);
	}

	const catalogPath = await p.text({
		message: "Catalog SQLite file",
		initialValue: "./catalog.db",
	});
	if (p.isCancel(catalogPath)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	// How hard to work to prove the destination is a bit-perfect copy of the source.
	// Applies to every produced file: flac --verify for encodes,
	// the decoded-audio hash compare for remux copies (FLAC/lossy/suspect).
	const paranoiaChoice = await p.select({
		message: "Verification paranoia (gates which sources become safe to delete)",
		options: Object.values(paranoiaOptions).map((level) => ({
			value: level,
			label: ParanoiaFriendlyNameMap[level].label,
			hint: ParanoiaFriendlyNameMap[level].hint,
		})),
		initialValue: paranoiaOptions.HashSHA256,
	});
	if (p.isCancel(paranoiaChoice)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}
	const paranoia = paranoiaChoice as Paranoia;

	const db = openCatalog(resolve(String(catalogPath)));

	// Phase 1: plan (read-only side: just classify and write rows into catalog).
	// No moves, conversions, or unlinks happen until after the confirmation below.
	const spin = p.spinner();
	spin.start(`Planning ${inbox}`);
	let items: PlanItem[];
	try {
		items = await planInbox(db, { inbox, archive } satisfies Roots);
	} catch (e) {
		spin.stop("Planning failed.");
		db.close();
		p.cancel(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
	spin.stop(`Planned ${items.length} file(s).`);

	if (items.length === 0) {
		db.close();
		p.outro("Inbox is empty. Nothing to do.");
		return;
	}

	const { byAction, totalBytes } = summarizePlan(items);
	const planLines: string[] = ["Plan:"];
	for (const action of ORDERED_ACTIONS) {
		const n = byAction[action];
		if (n === 0) continue;
		planLines.push(`  ${String(n).padStart(4)}  ${action}`);
	}
	planLines.push(`Total: ${humanSize(totalBytes)} across ${items.length} file(s)`);
	p.note(planLines.join("\n"), "Summary");

	const proceed = await p.confirm({
		message:
			"Execute this plan? Writes a sidecar + art and a tag-stripped copy under archive/ for each file; inbox sources are left untouched (delete later with pnpm purge).",
	});
	if (p.isCancel(proceed) || !proceed) {
		db.close();
		p.cancel("Cancelled before any file was touched.");
		process.exit(0);
	}

	// Phase 2: execute.
	// Per-file events stream to the log; the catalog updates as we go
	// so a mid-run crash leaves a consistent picture (rows reflect the state up to the last successful action).
	let oks = 0;
	let skips = 0;
	let errors = 0;
	for await (const ev of executePlan(db, items, paranoia)) {
		if (ev.kind === "ok") {
			oks++;
			const tail = ev.destPath ? ` -> ${ev.destPath}` : "";
			const extras = [ev.artCount > 0 ? `${ev.artCount} art` : null, ev.droppedCount > 0 ? `${ev.droppedCount} dropped` : null].filter(
				Boolean,
			);
			const meta = extras.length > 0 ? ` (${extras.join(", ")})` : "";
			const md5 = ev.md5 ? ` md5=${ev.md5}` : "";
			const sha256 = ev.sha256 ? ` sha256=${ev.sha256}` : "";
			p.log.step(`[${ev.action}] ${ev.srcPath}${tail}${meta}${md5}${sha256}`);
		} else if (ev.kind === "skip") {
			skips++;
			p.log.info(`[skip:${ev.action}] ${ev.srcPath} (${ev.note})`);
		} else {
			errors++;
			p.log.warn(`[error:${ev.action}] ${ev.srcPath}\n  ${ev.error}`);
		}
	}
	p.log.success(`Done: ${oks} ok, ${skips} skipped, ${errors} error(s).`);

	// Side artifact: write the safe-to-delete worklist for the human to inspect before running `pnpm purge`.
	// The actual deletion lives behind a separate explicit confirm in cli-purge.ts; this file is read-only auditing.
	const safe = findVerifiedSafeToDelete(db);
	const safeOnDisk: string[] = [];
	for (const r of safe) {
		if (r.originalPath && (await exists(r.originalPath))) {
			safeOnDisk.push(r.originalPath);
		}
	}
	const worklistPath = resolve("./reports/safe-to-delete.txt");
	await mkdir(dirname(worklistPath), { recursive: true });
	await writeFile(worklistPath, safeOnDisk.length > 0 ? `${safeOnDisk.join("\n")}\n` : "", "utf8");
	p.log.info(
		safeOnDisk.length > 0
			? `Wrote ${safeOnDisk.length} verified-source path(s) to ${worklistPath}. Run pnpm purge to delete.`
			: `No verified sources pending purge. (${worklistPath} is empty.)`,
	);

	const reportNow = await p.confirm({
		message: "Regenerate Markdown report now?",
	});
	// noinspection DuplicatedCode
	if (p.isCancel(reportNow) || !reportNow) {
		db.close();
		p.outro("Done. Skipped report.");
		return;
	}

	const today = new Date().toISOString().slice(0, 10);
	const reportPath = await p.text({
		message: "Report output path",
		initialValue: `./reports/${today}-pipeline.md`,
	});
	if (p.isCancel(reportPath)) {
		db.close();
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const { tracks } = await generateReport(db, resolve(String(reportPath)), {
		roots: [inbox, archive],
	});
	db.close();
	p.outro(`Report written: ${tracks} track(s).`);
}

const ORDERED_ACTIONS: Action[] = ["encode-to-flac", "copy-strip", "skip-already-processed", "skip-dest-exists"];

async function isDir(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
