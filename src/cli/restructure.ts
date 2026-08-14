// noinspection DuplicatedCode

import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { openCatalog } from "../libs/catalog.ts";
import { type OutputParanoia, outputParanoiaOptions, ParanoiaFriendlyNameMap, paranoiaOptions } from "../libs/convert.ts";
import { executeRestructure, planRestructure, type RestructurePlanAlbum } from "../libs/restructure.ts";

async function main(): Promise<void> {
	p.intro("gem-stash restructure (final artist-first archive)");

	const workRoot = await p.text({
		message: "Work root (contains archive/ and gets final_archive/)",
		initialValue: "./work",
		validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
	});
	if (p.isCancel(workRoot)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const work = resolve(String(workRoot));
	const archive = join(work, "archive");
	if (!(await isDir(archive))) {
		p.cancel(`Archive path does not exist or is not a directory: ${archive}`);
		process.exit(1);
	}
	const finalRoot = join(work, "final_archive");

	const catalogPath = await p.text({
		message: "Catalog SQLite file",
		initialValue: "./catalog.db",
	});
	if (p.isCancel(catalogPath)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const db = openCatalog(resolve(String(catalogPath)));

	let plans: RestructurePlanAlbum[];
	try {
		plans = await planRestructure(db);
	} catch (e) {
		db.close();
		p.cancel(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}

	if (plans.length === 0) {
		db.close();
		p.outro("No processed albums in the catalog. Run pnpm process first.");
		return;
	}

	const ready = plans.filter((pl) => pl.ready);
	const notReady = plans.filter((pl) => !pl.ready);
	const placeable = ready.reduce((acc, pl) => acc + pl.placeable, 0);
	const suspectTracks = plans.reduce((acc, pl) => acc + pl.skippedTracks, 0);

	if (notReady.length > 0) {
		p.note(notReady.map((pl) => `  ${pl.group.artist} / ${pl.group.album}: ${pl.skipReason}`).join("\n"), "Skipping (not ready to place)");
	}

	if (ready.length === 0) {
		db.close();
		p.outro("No albums are ready. Run pnpm scaffold + pnpm tag first.");
		return;
	}

	p.note(
		[
			`Ready to place:      ${ready.length} album(s), ${placeable} file(s)`,
			`Not ready:           ${notReady.length} album(s)`,
			`Suspect (skipped):   ${suspectTracks} track(s)`,
			"",
			"This COPIES files into final_archive/; the archive/ tree is left untouched.",
		].join("\n"),
		"Summary",
	);

	// A copy plus a metadata-only tag write is audio-preserving by construction,
	// so the audio compare is off by default; enable it for belt-and-suspenders.
	const paranoiaChoice = await p.select({
		message: "Verification paranoia (gates which sources become safe to delete)",
		options: Object.values(outputParanoiaOptions).map((level) => ({
			value: level,
			label: ParanoiaFriendlyNameMap[level].label,
			hint: ParanoiaFriendlyNameMap[level].hint,
		})),
		initialValue: paranoiaOptions.None,
	});
	if (p.isCancel(paranoiaChoice)) {
		db.close();
		p.cancel("Cancelled.");
		process.exit(0);
	}
	const paranoia = paranoiaChoice as OutputParanoia;

	const overwrite = await p.confirm({
		message: "Overwrite files that already exist in final_archive? (No = skip existing.)",
		initialValue: false,
	});
	if (p.isCancel(overwrite)) {
		db.close();
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const proceed = await p.confirm({
		message: `Copy ${placeable} file(s) across ${ready.length} album(s) into ${finalRoot}? The archive/ masters are not touched.`,
	});
	if (p.isCancel(proceed) || !proceed) {
		db.close();
		p.cancel("Cancelled before any file was written.");
		process.exit(0);
	}

	let okFiles = 0;
	let skipFiles = 0;
	let failFiles = 0;
	for await (const ev of executeRestructure(plans, { finalRoot, paranoia, overwrite })) {
		switch (ev.kind) {
			case "album-start":
				p.log.step(`${ev.artist} / ${ev.album} (${ev.trackCount} track(s))`);
				break;
			case "track-ok": {
				okFiles++;
				const notes = [
					ev.artEmbedded ? "art" : null,
					ev.verifiedHash ? "verified" : null,
					ev.mismatches.length > 0 ? `${ev.mismatches.length} readback mismatch` : null,
				].filter(Boolean);
				const tail = notes.length > 0 ? ` (${notes.join(", ")})` : "";
				p.log.info(`  ok ${ev.dest}${tail}`);
				if (ev.mismatches.length > 0) {
					for (const m of ev.mismatches) p.log.warn(`     ${m}`);
				}
				break;
			}
			case "track-skip":
				skipFiles++;
				p.log.info(`  skip ${ev.file} (${ev.note})`);
				break;
			case "track-error":
				failFiles++;
				p.log.warn(`  error ${ev.file}: ${ev.error}`);
				break;
			case "album-done":
				p.log[ev.failed === 0 ? "success" : "warn"](
					`  ${ev.artist} / ${ev.album}: ${ev.placed} placed, ${ev.skipped} skipped, ${ev.failed} failed`,
				);
				break;
		}
	}

	db.close();
	p.log.success(`Done: ${okFiles} placed, ${skipFiles} skipped, ${failFiles} error(s).`);
	p.outro(`Final archive in ${finalRoot}. Once you are happy, the staging archive/ can be removed.`);
}

async function isDir(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
