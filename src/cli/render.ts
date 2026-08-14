import * as p from "@clack/prompts";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { openCatalog } from "../libs/catalog.ts";
import { executeRender, planRender, type RenderPlanAlbum } from "../libs/render.ts";
import { type Paranoia, ParanoiaFriendlyNameMap, paranoiaOptions, type OutputParanoia, outputParanoiaOptions } from "../libs/convert.ts";

async function main(): Promise<void> {
	p.intro("gem-stash render (ALAC m4a for Apple)");

	const workRoot = await p.text({
		message: "Work root (contains archive/ and gets renders/apple/)",
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
	const renderRoot = join(work, "renders", "apple");

	const catalogPath = await p.text({
		message: "Catalog SQLite file",
		initialValue: "./catalog.db",
	});
	if (p.isCancel(catalogPath)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const db = openCatalog(resolve(String(catalogPath)));

	let plans: RenderPlanAlbum[];
	try {
		plans = await planRender(db);
	} catch (e) {
		db.close();
		p.cancel(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}

	if (plans.length === 0) {
		db.close();
		p.outro("No processed albums in the catalog. Run `pnpm process` first.");
		return;
	}

	const ready = plans.filter((pl) => pl.ready);
	const notReady = plans.filter((pl) => !pl.ready);
	const losslessTracks = ready.reduce((acc, pl) => acc + pl.losslessTracks, 0);
	const lossyTracks = ready.reduce((acc, pl) => acc + pl.lossyTracks, 0);
	const renderTracks = losslessTracks + lossyTracks;
	const suspectTracks = plans.reduce((acc, pl) => acc + pl.skippedTracks, 0);

	if (notReady.length > 0) {
		p.note(notReady.map((pl) => `  ${pl.group.artist} / ${pl.group.album}: ${pl.skipReason}`).join("\n"), "Skipping (not ready to render)");
	}

	if (ready.length === 0) {
		db.close();
		p.outro("No albums are ready to render. Run pnpm scaffold + pnpm tag first.");
		return;
	}

	p.note(
		[
			`Ready to render:     ${ready.length} album(s), ${renderTracks} track(s)`,
			`  lossless -> ALAC:  ${losslessTracks}`,
			`  lossy -> AAC:      ${lossyTracks}`,
			`Not ready:           ${notReady.length} album(s)`,
			`Suspect (skipped):   ${suspectTracks} track(s)`,
		].join("\n"),
		"Summary",
	);

	// ALAC is lossless, so running transcode should be bit-identical to the master.
	// The compare proves it rather than trusting it; SHA-256 by default.
	const paranoiaChoice = await p.select({
		message: "Verification paranoia (gates which sources become safe to delete)",
		options: Object.values(outputParanoiaOptions).map((level) => ({
			value: level,
			label: ParanoiaFriendlyNameMap[level].label,
			hint: ParanoiaFriendlyNameMap[level].hint,
		})),
		initialValue: paranoiaOptions.HashSHA256,
	});
	if (p.isCancel(paranoiaChoice)) {
		db.close();
		p.cancel("Cancelled.");
		process.exit(0);
	}
	const paranoia = paranoiaChoice as OutputParanoia;

	const overwriteConfirm = await p.confirm({
		message: "Overwrite renders that already exist? (No = skip existing.)",
		initialValue: false,
	});
	if (p.isCancel(overwriteConfirm)) {
		db.close();
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const proceed = await p.confirm({
		message: `Render ${renderTracks} track(s) across ${ready.length} album(s) to ${renderRoot}? Nothing in archive/ is touched.`,
	});
	if (p.isCancel(proceed) || !proceed) {
		db.close();
		p.cancel("Cancelled before any file was written.");
		process.exit(0);
	}

	let okFiles = 0;
	let skipFiles = 0;
	let failFiles = 0;
	for await (const renderEvent of executeRender(plans, { renderRoot, paranoia, overwrite: overwriteConfirm })) {
		switch (renderEvent.kind) {
			case "album-start":
				p.log.step(`${renderEvent.artist} / ${renderEvent.album} (${renderEvent.trackCount} track(s))`);
				break;
			case "track-ok": {
				okFiles++;
				const modeLabel = renderEvent.mode === "alac" ? "ALAC" : renderEvent.mode === "aac-copy" ? "AAC (copied)" : "AAC (re-encoded)";
				const notes = [
					modeLabel,
					renderEvent.artEmbedded ? "art" : null,
					renderEvent.verifiedHash ? "verified" : null,
					renderEvent.mismatches.length > 0 ? `${renderEvent.mismatches.length} readback mismatch` : null,
				].filter(Boolean);
				const tail = notes.length > 0 ? ` (${notes.join(", ")})` : "";
				p.log.info(`  ok ${renderEvent.dest}${tail}`);
				if (renderEvent.mismatches.length > 0) {
					for (const m of renderEvent.mismatches) p.log.warn(`     ${m}`);
				}
				break;
			}
			case "track-skip":
				skipFiles++;
				p.log.info(`  skip ${renderEvent.file} (${renderEvent.note})`);
				break;
			case "track-error":
				failFiles++;
				p.log.warn(`  error ${renderEvent.file}: ${renderEvent.error}`);
				break;
			case "album-done":
				p.log[renderEvent.failed === 0 ? "success" : "warn"](
					`  ${renderEvent.artist} / ${renderEvent.album}: ${renderEvent.rendered} rendered, ${renderEvent.skipped} skipped, ${renderEvent.failed} failed`,
				);
				break;
		}
	}

	db.close();
	p.log.success(`Done:\n - ${okFiles} rendered,\n - ${skipFiles} skipped,\n - ${failFiles} error(s).`);
	p.note(
		[
			`Renders are in ${renderRoot}`,
			"",
			"Move or copy files from the render path to:",
			"~/Music/Music/Media/Automatically\\ Add\\ to\\ Music",
			"(or whatever your Apple Music settings for this folder is).",
			"Apple Music will then index them and place them into the Library automatically.",
		].join("\n"),
		"Load onto iPhone",
	);
	p.outro("MVP render complete.");
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
