import * as p from "@clack/prompts";
import { resolve } from "node:path";
import { openCatalog } from "../libs/catalog.ts";
import { executeScaffold, planScaffold, type ScaffoldPlanItem } from "../libs/scaffold.ts";

async function main(): Promise<void> {
	p.intro("gem-stash scaffold (album masters)");

	const catalogPath = await p.text({
		message: "Catalog SQLite file",
		initialValue: "./catalog.db",
	});
	if (p.isCancel(catalogPath)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const db = openCatalog(resolve(String(catalogPath)));

	let items: ScaffoldPlanItem[];
	try {
		items = await planScaffold(db);
	} catch (e) {
		db.close();
		p.cancel(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}

	if (items.length === 0) {
		db.close();
		p.outro("No processed albums in the catalog. Run pnpm process first.");
		return;
	}

	const missing = items.filter((i) => !i.exists);
	const existing = items.filter((i) => i.exists);

	p.note(
		[
			`Albums total:        ${items.length}`,
			`Without a master:    ${missing.length} (will be created)`,
			`With a master:       ${existing.length} (left alone unless you refresh)`,
		].join("\n"),
		"Summary",
	);

	// Refreshing rebuilds an existing master from the per-file sidecars,
	// which overwrites any hand-edits.
	// Off by default; opt in explicitly.
	let overwrite = false;
	if (existing.length > 0) {
		const ans = await p.confirm({
			message: `Also refresh the ${existing.length} existing master(s)? This OVERWRITES any hand-edits in them.`,
			initialValue: false,
		});
		if (p.isCancel(ans)) {
			db.close();
			p.cancel("Cancelled.");
			process.exit(0);
		}
		overwrite = ans;
	}

	if (missing.length === 0 && !overwrite) {
		db.close();
		p.outro("Every album already has a master. Nothing to do.");
		return;
	}

	const proceed = await p.confirm({
		message: overwrite ? `Create ${missing.length} master(s) and refresh ${existing.length}?` : `Create ${missing.length} album master(s)?`,
	});
	if (p.isCancel(proceed) || !proceed) {
		db.close();
		p.cancel("Cancelled before any write.");
		process.exit(0);
	}

	let created = 0;
	let refreshed = 0;
	let skipped = 0;
	let errors = 0;
	for await (const ev of executeScaffold(items, { overwrite })) {
		switch (ev.kind) {
			case "created":
				created++;
				p.log.step(`created ${ev.path} (${ev.trackCount} track(s))`);
				break;
			case "refreshed":
				refreshed++;
				p.log.step(`refreshed ${ev.path} (${ev.trackCount} track(s))`);
				break;
			case "skipped":
				skipped++;
				p.log.info(`skipped ${ev.path} (${ev.reason})`);
				break;
			case "error":
				errors++;
				p.log.warn(`error ${ev.path}: ${ev.error}`);
				break;
		}
	}

	db.close();
	p.outro(
		`Done: \n - ${created} created,\n - ${refreshed} refreshed,\n - ${skipped} skipped,\n - ${errors} error(s).\n\n` +
			"Review the album.sidecar.json files, then run pnpm tag.",
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
