import * as p from "@clack/prompts";
import { join, resolve } from "node:path";
import { openCatalog } from "../libs/catalog.ts";
import { executePurge, planPurge, type PurgePlan } from "../libs/purge.ts";
import { humanSize } from "../common/format.helpers.ts";

async function main(): Promise<void> {
	p.intro("gem-stash purge");

	const workRoot = await p.text({
		message: "Work root (contains inbox/ and archive/)",
		initialValue: "./work",
		validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
	});
	if (p.isCancel(workRoot)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}
	const inbox = join(resolve(String(workRoot)), "inbox");

	const catalogPath = await p.text({
		message: "Catalog SQLite file",
		initialValue: "./catalog.db",
	});
	if (p.isCancel(catalogPath)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const db = openCatalog(resolve(String(catalogPath)));
	let plan: PurgePlan;
	try {
		plan = await planPurge(db);
	} catch (e) {
		db.close();
		p.cancel(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}

	if (plan.onDisk.length === 0 && plan.missing.length === 0) {
		db.close();
		p.outro("Nothing to purge.");
		return;
	}

	// Only stale pointers to clear: a single confirm, no file deletion.
	if (plan.onDisk.length === 0) {
		const ack = await p.confirm({
			message: `${plan.missing.length} catalog row(s) point to source files that no longer exist on disk. Clear the pointers?`,
		});
		if (p.isCancel(ack) || !ack) {
			db.close();
			p.cancel("Cancelled.");
			process.exit(0);
		}
		// executePurge with no on-disk items just clears the missing pointers.
		for await (const _ of executePurge(db, inbox, plan)) {
			/* no events for a pointers-only run */
		}
		db.close();
		p.outro(`Cleared ${plan.missing.length} stale pointer(s).`);
		return;
	}

	// Show the full list before they say yes.
	// No paging: a long list is exactly when the user wants to see everything.
	const totalBytes = plan.onDisk.reduce((acc, x) => acc + x.size, 0);
	const lines: string[] = [];
	for (const x of plan.onDisk) {
		lines.push(`  ${humanSize(x.size).padStart(8)}  ${x.originalPath}`);
	}
	lines.push("");
	lines.push(`Total: ${humanSize(totalBytes)} across ${plan.onDisk.length} file(s).`);
	if (plan.missing.length > 0) {
		lines.push(`(${plan.missing.length} other catalog row(s) point to files already gone from disk; their pointers will also be cleared.)`);
	}
	p.note(lines.join("\n"), "Verified sources to delete");
	p.note(
		[
			"After deletion, any inbox folder left with no media files is swept:",
			"leftover files (cdparanoia.log, .cue, cover art) are copied into the",
			"destination folder(s) their media went to, then the empty inbox folder",
			"is removed. Dotfiles (.DS_Store) are dropped, not copied.",
		].join("\n"),
		"Folder cleanup",
	);

	const proceed = await p.confirm({
		message: `Permanently delete ${plan.onDisk.length} source file(s) and clean up emptied inbox folders? This cannot be undone.`,
	});
	if (p.isCancel(proceed) || !proceed) {
		db.close();
		p.cancel("Cancelled. No files were touched.");
		process.exit(0);
	}

	let deleted = 0;
	let swept = 0;
	let removedDirs = 0;
	let errors = 0;
	for await (const ev of executePurge(db, inbox, plan)) {
		switch (ev.kind) {
			case "deleted":
				deleted++;
				p.log.step(`deleted ${ev.path}`);
				break;
			case "swept":
				swept++;
				p.log.step(`swept ${ev.from} -> ${ev.to}`);
				break;
			case "removed-dir":
				removedDirs++;
				p.log.info(`removed empty folder ${ev.path}`);
				break;
			case "kept-dir":
				p.log.info(`kept ${ev.path} (${ev.reason})`);
				break;
			case "delete-error":
				errors++;
				p.log.warn(`failed to delete ${ev.path}: ${ev.error}`);
				break;
			case "sweep-error":
				errors++;
				p.log.warn(`sweep failed for ${ev.from}: ${ev.error}`);
				break;
		}
	}

	db.close();
	p.outro(`Purged ${deleted} file(s), swept ${swept} leftover(s), removed ${removedDirs} folder(s), ${errors} error(s).`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
