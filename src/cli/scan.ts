import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { openCatalog } from "../libs/catalog.ts";
import { generateReport } from "../libs/report.ts";
import { scan } from "../libs/scan.ts";

async function main(): Promise<void> {
	p.intro("gem-stash scanner");

	const musicDir = await p.text({
		message: "Music directory to scan",
		placeholder: "./work/inbox",
		initialValue: "./work/inbox",
		validate: (v) => (!v || v.trim().length === 0 ? "Required" : undefined),
	});
	if (p.isCancel(musicDir)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}
	const root = resolve(String(musicDir));

	try {
		const s = await stat(root);
		if (!s.isDirectory()) {
			p.cancel(`Not a directory: ${root}`);
			process.exit(1);
		}
	} catch {
		p.cancel(`Path does not exist: ${root}`);
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

	const proceed = await p.confirm({
		message: `Scan ${root} and write to ${catalogPath}?`,
	});
	if (p.isCancel(proceed) || !proceed) {
		p.cancel("Cancelled before any write.");
		process.exit(0);
	}

	const db = openCatalog(resolve(String(catalogPath)));

	let count = 0;
	let errors = 0;
	let total = 0;

	for await (const ev of scan(root, db)) {
		if (ev.kind === "file") {
			count++;
			p.log.step(`[${ev.verdict.padEnd(14)}] ${ev.codec.padEnd(6)} ${ev.inspector.padEnd(7)} ${ev.path}`);
		} else if (ev.kind === "cached") {
			count++;
			p.log.step(`[${ev.verdict.padEnd(14)}] ${ev.codec.padEnd(6)} cached  ${ev.path}`);
		} else if (ev.kind === "error") {
			errors++;
			p.log.warn(`error: ${ev.path}\n  ${ev.error}`);
		} else {
			total = ev.total;
			p.log.success(`Scanned ${ev.total} file(s): ${ev.fresh} fresh, ${ev.cached} cached, ${ev.errors} error(s).`);
		}
	}

	if (total === 0) {
		db.close();
		p.outro("No audio files found. Nothing to report.");
		return;
	}

	const reportNow = await p.confirm({
		message: "Generate Markdown report now?",
	});
	if (p.isCancel(reportNow) || !reportNow) {
		db.close();
		p.outro(`Catalog written (${count} files). Errors during run: ${errors}. Skipped report.`);
		return;
	}

	const today = new Date().toISOString().slice(0, 10);
	const reportPath = await p.text({
		message: "Report output path",
		initialValue: `./reports/${today}-quality.md`,
	});
	if (p.isCancel(reportPath)) {
		db.close();
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const confirmWrite = await p.confirm({
		message: `Write report to ${reportPath}?`,
	});
	if (p.isCancel(confirmWrite) || !confirmWrite) {
		db.close();
		p.outro(`Catalog written (${count} files). Errors during run: ${errors}. Skipped report.`);
		return;
	}

	const { albums, tracks } = await generateReport(db, resolve(String(reportPath)), {
		roots: [root],
	});
	db.close();
	p.outro(`Report written: ${albums} album(s), ${tracks} track(s).` + `Catalog written (${count} files).` + `Errors during run: ${errors}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
