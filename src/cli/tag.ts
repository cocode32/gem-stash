import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { writeAlbumSidecar } from "../libs/album-sidecar.ts";
import { openCatalog } from "../libs/catalog.ts";
import { generateReport } from "../libs/report.ts";
import { type AlbumPlan, executeTagging, planTagging, type TagJob, validateAlbum } from "../libs/tag.ts";

// Sentinel for "let me type a value the list doesn't offer".
const CUSTOM = "custom";

async function main(): Promise<void> {
	p.intro("gem-stash tag (write metadata + art)");

	const workRoot = await p.text({
		message: "Work root (contains archive/)",
		initialValue: "./work",
		validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
	});
	if (p.isCancel(workRoot)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const archive = join(resolve(String(workRoot)), "archive");
	if (!(await isDir(archive))) {
		p.cancel(`Archive path does not exist or is not a directory: ${archive}`);
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

	const db = openCatalog(resolve(String(catalogPath)));

	let plans: AlbumPlan[];
	try {
		plans = await planTagging(db);
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

	const noMaster = plans.filter((pl) => !pl.sidecar);
	if (noMaster.length > 0) {
		p.note(
			[
				`${noMaster.length} album(s) have no master and will be skipped.`,
				"Run pnpm scaffold to build them, then edit the album.sidecar.json files.",
				"",
				...noMaster.map((pl) => `  ${pl.group.artist} / ${pl.group.album}`),
			].join("\n"),
			"Missing album masters",
		);
	}

	// Resolve each album with a master:
	// - prompt for a missing albumartist,
	// - set the compilation flag where the track artists vary,
	// - persist those decisions back into the master,
	// - then re-validate.
	// Albums that still have blocking issues are reported and skipped.
	const jobs: TagJob[] = [];
	const skipped: { label: string; issues: string[] }[] = [];

	for (const tagPlan of plans) {
		if (!tagPlan.sidecar || !tagPlan.validation) continue;

		const label = `${tagPlan.group.artist} / ${tagPlan.group.album}`;
		const sidecar = tagPlan.sidecar;
		let validation = tagPlan.validation;
		let changed = false;

		if (validation.blocking.length > 0) {
			skipped.push({ label, issues: validation.blocking });
			continue;
		}

		if (validation.needsAlbumArtist) {
			const chosen = await resolveAlbumArtist(label, tagPlan.albumArtistChoices);
			if (p.isCancel(chosen)) {
				db.close();
				p.cancel("Cancelled.");
				process.exit(0);
			}

			sidecar.album.albumArtist = String(chosen).trim();
			changed = true;
		}

		if (validation.needsCompilation) {
			sidecar.album.compilation = "1";
			changed = true;

			p.log.info(`[${label}] set compilation = 1 (multiple track artists).`);
		}

		if (changed) {
			await writeAlbumSidecar(tagPlan.group.albumSidecarPath, sidecar);
			validation = validateAlbum(sidecar);
		}

		jobs.push({ group: tagPlan.group, sidecar, validation });
	}

	for (const s of skipped) {
		p.note(s.issues.map((i) => `- ${i}`).join("\n"), `Skipping (blocking issues): ${s.label}`);
	}

	if (jobs.length === 0) {
		db.close();
		p.outro("No albums are ready to tag.");
		return;
	}

	const trackCount = jobs.reduce((acc, j) => acc + j.sidecar.tracks.length, 0);
	p.note(
		[
			`Ready to tag:        ${jobs.length} album(s), ${trackCount} file(s)`,
			`Missing master:      ${noMaster.length}`,
			`Skipped (blocking):  ${skipped.length}`,
		].join("\n"),
		"Summary",
	);

	const proceed = await p.confirm({
		message: `Write tags + front art onto ${trackCount} file(s) across ${jobs.length} album(s)? Audio is never modified (FLAC via metaflac, others via ffmpeg -c:a copy). Existing files are replaced in place.`,
	});
	if (p.isCancel(proceed) || !proceed) {
		db.close();
		p.cancel("Cancelled before any file was touched.");
		process.exit(0);
	}

	let okFiles = 0;
	let failedFiles = 0;
	let notReady = 0;
	for await (const ev of executeTagging(db, jobs)) {
		switch (ev.kind) {
			case "album-start":
				p.log.step(`${ev.artist} / ${ev.album} (${ev.trackCount} track(s))`);
				break;
			case "track-ok": {
				okFiles++;
				const notes = [
					ev.artEmbedded ? "art" : null,
					ev.artMissing ? "art file missing" : null,
					ev.mismatches.length > 0 ? `${ev.mismatches.length} readback mismatch` : null,
				].filter(Boolean);
				const tail = notes.length > 0 ? ` (${notes.join(", ")})` : "";
				p.log.info(`  ok ${ev.file}${tail}`);
				if (ev.mismatches.length > 0) {
					for (const m of ev.mismatches) p.log.warn(`     ${m}`);
				}
				break;
			}
			case "track-error":
				failedFiles++;
				p.log.warn(`  error ${ev.file}: ${ev.error}`);
				break;
			case "album-done":
				if (!ev.appleReady) notReady++;
				p.log[ev.appleReady ? "success" : "warn"](
					`  ${ev.artist} / ${ev.album}: Apple-ready ${ev.appleReady ? "yes" : "no"} (${ev.ok} ok, ${ev.failed} failed)`,
				);
				break;
		}
	}
	p.log.success(`Done: \n - ${okFiles} file(s) tagged,\n - ${failedFiles} error(s),\n - ${notReady} album(s) not Apple-ready.`);

	const reportNow = await p.confirm({ message: "Regenerate Markdown report now?" });
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

	const { tracks } = await generateReport(db, resolve(String(reportPath)), { roots: [archive] });
	db.close();
	p.outro(`Report written: ${tracks} track(s).`);
}

/**
 * Prompt for the canonical album artist,
 * offering the distinct values found as quick picks,
 * plus a free-text escape.
 *
 * The right answer for a comp is often the compiler/DJ, which is not among the per-track artists.
 */
async function resolveAlbumArtist(label: string, choices: string[]): Promise<string | symbol> {
	const message = `Album artist for ${label}`;
	if (choices.length === 0) {
		return p.text({
			message: `${message} (none found; e.g. the compiler / DJ)`,
			validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
		});
	}
	const choice = await p.select({
		message,
		options: [...choices.map((c) => ({ value: c, label: c })), { value: CUSTOM, label: "Enter a different value..." }],
	});
	if (p.isCancel(choice) || choice !== CUSTOM) return choice;
	return p.text({
		message,
		validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
	});
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
