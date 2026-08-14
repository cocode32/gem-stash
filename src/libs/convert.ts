// noinspection ExceptionCaughtLocallyJS -- expected behaviour where throws occur

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { findByPath } from "./catalog.ts";
import { detectAudioCodec, flacCanReadDirectly } from "../common/audio.helpers.ts";
import { exists, safeUnlink } from "../common/file.helpers.ts";

const exec = promisify(execFile);

export const paranoiaOptions = {
	None: 0,
	Verify: 1,
	Test: 2,
	HashMD5: 3,
	HashSHA256: 4,
} as const;
export const outputParanoiaOptions = {
	None: 0,
	HashMD5: 3,
	HashSHA256: 4,
} as const;

export type Paranoia = (typeof paranoiaOptions)[keyof typeof paranoiaOptions];
export type OutputParanoia = (typeof outputParanoiaOptions)[keyof typeof outputParanoiaOptions];

type SelectMapParams = {
	label: string;
	hint: string;
};

export type ParanoiaHashingAlgorithm = "md5" | "sha256";

export const ParanoiaFriendlyNameMap: Record<Paranoia, SelectMapParams> = {
	0: {
		label: "None - Raw Crash",
		hint: "convert only, no checks",
	},
	1: {
		label: "Verify - One Mask",
		hint: "flac --verify",
	},
	2: {
		label: "Test - Two Masks",
		hint: "+ flac -t",
	},
	3: {
		label: "MD5 Hash - Three Masks",
		hint: "+ MD5 audio compare",
	},
	4: {
		label: "SHA256 - Invincibility",
		hint: "+ SHA-256 audio compare",
	},
};

export type EncodeResult = {
	destPath: string;
	/**
	 * libFLAC STREAMINFO PCM MD5, present at paranoia >= Test.
	 * This is the FLAC's own declared PCM hash; verifyMd5Source/Dest in the catalog hold it.
	 */
	streamInfoMd5: string | null;
	/**
	 * ffmpeg end-to-end decoded-audio MD5, proven equal between source and flac.
	 * Present only when the audio compare ran with md5 (paranoia == HashMD5).
	 */
	audioMd5: string | null;
	/**
	 * ffmpeg end-to-end decoded-audio SHA-256, proven equal between source and flac.
	 * Present at paranoia >= HashSHA256.
	 */
	audioSha256: string | null;
};

// --verify is itself a paranoia layer: only request it at level >= 1.
function baseFlacArgs(tmpPath: string, paranoia: Paranoia): string[] {
	const args = ["--silent", "--best"];
	if (paranoia >= paranoiaOptions.Verify) args.push("--verify");
	args.push("-o", tmpPath);
	return args;
}

export async function encodeToFlacWithVerify(
	db: DatabaseSync,
	srcPath: string,
	destPath: string,
	paranoia: Paranoia,
): Promise<EncodeResult> {
	if (await exists(destPath)) {
		throw new Error(`Destination already exists: ${destPath}`);
	}
	await mkdir(dirname(destPath), { recursive: true });

	// Write to a sibling .tmp.flac so a crashed encode never leaves a half-baked
	// file at the final path. Final rename only happens after `flac -t` passes.
	const tmpPath = `${destPath}.tmp.flac`;
	await safeUnlink(tmpPath);

	// In the normal `pnpm process` flow planInbox upserts the row before we
	// ever reach here, so the catalog lookup is the hot path.
	// The disk fallback is defensive: if some future caller invokes encodeToFlacWithVerify without
	// pre-scanning, we still get a real codec read rather than throwing.
	const codec = findByPath(db, srcPath)?.codec ?? detectAudioCodec(srcPath);

	// Hashes we manage to compute on the way up the paranoia ladder.
	// Anything not reached at the chosen level stays null and is stored as NULL in the catalog.
	let streamInfoMd5: string | null = null;
	let audioMd5: string | null = null;
	let audioSha256: string | null = null;

	// encode/re-encode
	try {
		const flacArgs = baseFlacArgs(tmpPath, paranoia);
		if (flacCanReadDirectly(codec)) {
			await exec("flac", [...flacArgs, srcPath]);
		} else {
			await encodeViaFfmpegPipe(srcPath, [...flacArgs, "-"]);
		}

		if (paranoia >= paranoiaOptions.Test) {
			await exec("flac", ["-t", "--silent", tmpPath]); // throws on failure
			streamInfoMd5 = await flacStoredMd5(tmpPath);
			if (!streamInfoMd5 || /^0+$/.test(streamInfoMd5)) {
				throw new Error(`FLAC has no stored PCM MD5: ${tmpPath}`);
			}
		}

		// --- Levels 3 & 4: end-to-end decoded-audio hash compare ---
		if (paranoia >= paranoiaOptions.HashMD5) {
			const algo: ParanoiaHashingAlgorithm = paranoia >= paranoiaOptions.HashSHA256 ? "sha256" : "md5";
			const [srcHash, flacHash] = await Promise.all([fullAudioHash(srcPath, algo), fullAudioHash(tmpPath, algo)]);
			if (srcHash !== flacHash || !srcHash) {
				throw new Error(`Audio hash mismatch (${algo}) for ${srcPath}: source ${srcHash} vs flac ${flacHash}`);
			}
			// Both sides matched, so either value is the proven hash.
			// Record it under the algorithm that actually ran.
			if (algo === "sha256") audioSha256 = flacHash;
			else audioMd5 = flacHash;
		}

		// Only reached if every requested check passed.
		// Promote file from tmp to final file
		await rename(tmpPath, destPath);

		return { destPath, streamInfoMd5, audioMd5, audioSha256 };
	} catch (e) {
		await safeUnlink(tmpPath);
		throw e;
	}
}

export type StripResult = {
	destPath: string;
	/**
	 * decoded-audio compare hashes, proven equal source vs destination.
	 * Present only at the matching paranoia level; remux copies have no STREAMINFO MD5.
	 */
	audioMd5: string | null;
	/**
	 * decoded-audio compare hashes, proven equal source vs destination.
	 * Present only at the matching paranoia level; remux copies have no STREAMINFO MD5.
	 */
	audioSha256: string | null;
};

/**
 * Remux a file into destPath dropping all tags and non-audio streams
 * (including embedded art), copying the audio bitstream untouched (-c:a copy: no re-encode, no quality change).
 * Used for FLAC masters, lossy files, and suspect files:
 * the destination is a clean, tagless container.
 * The inbox source is left in place.
 *
 * Writes to a sibling temp and only renames into destPath after the paranoia check passes,
 * so a failed strip never leaves a half-baked destination.
 * At paranoia >= Verify the decoded audio of source and temp are hashed and compared (md5 up to HashMD5, sha256 at HashSHA256);
 * a mismatch aborts.
 *
 * @param srcPath The source file
 * @param destPath The destination target file
 * @param paranoia Paranoia level to apply
 */
export async function remuxStripTo(srcPath: string, destPath: string, paranoia: Paranoia): Promise<StripResult> {
	if (await exists(destPath)) {
		throw new Error(`Destination already exists: ${destPath}`);
	}
	await mkdir(dirname(destPath), { recursive: true });

	const tmpPath = `${destPath}.tmp${extname(destPath)}`;
	await safeUnlink(tmpPath);

	let audioMd5: string | null = null;
	let audioSha256: string | null = null;

	try {
		await exec("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			srcPath,
			"-map",
			"0:a",
			"-map_metadata",
			"-1",
			"-c:a",
			"copy",
			tmpPath,
		]);

		if (paranoia >= paranoiaOptions.Verify) {
			const algo: ParanoiaHashingAlgorithm = paranoia >= paranoiaOptions.HashSHA256 ? "sha256" : "md5";
			const [srcHash, dstHash] = await Promise.all([encodedAudioHash(srcPath, algo), encodedAudioHash(tmpPath, algo)]);
			if (!srcHash || srcHash !== dstHash) {
				throw new Error(`Strip changed audio (${algo}) for ${srcPath}: source ${srcHash} vs dest ${dstHash}`);
			}
			if (algo === "sha256") audioSha256 = dstHash;
			else audioMd5 = dstHash;
		}

		await rename(tmpPath, destPath);
		return { destPath, audioMd5, audioSha256 };
	} catch (e) {
		await safeUnlink(tmpPath);
		throw e;
	}
}

/**
 * @param srcPath the original file
 * @param flacArgs args to pass the flac command
 *
 * Comment on presence of `wav` in the decoder section:
 * The flow is:
 *   - ffmpeg reads any source
 *   - decodes it to raw PCM samples
 *   - re-wraps those samples as a WAV stream for the pipe
 * The wav here is the intermediate transport format feeding into flac's stdin, not an assumption about the source.
 * An AIFF source, an ALAC source, a 24-bit WAV source, all get decoded to PCM and emerge as a WAV stream.
 * That's exactly what you want, because flac reads WAV-on-stdin happily.
 *
 * So passing "the actual codec" would be the wrong move here.
 * You don't want to tell ffmpeg "output ALAC" or "output as the source codec",
 * you want it to output decoded PCM in a flac-readable wrapper,
 * and WAV is the standard choice for that.
 * The hardcoded wav is correct and source-agnostic.
 *
 * Leave it.
 */
async function encodeViaFfmpegPipe(srcPath: string, flacArgs: string[]): Promise<void> {
	const decoder = spawn(
		"ffmpeg",
		["-hide_banner", "-nostats", "-loglevel", "error", "-i", srcPath, "-map", "0:a", "-map_metadata", "-1", "-f", "wav", "pipe:1"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const encoder = spawn("flac", flacArgs, { stdio: ["pipe", "ignore", "pipe"] });

	const decoderErr: Buffer[] = [];
	const encoderErr: Buffer[] = [];
	decoder.stderr?.on("data", (b: Buffer) => decoderErr.push(b));
	encoder.stderr?.on("data", (b: Buffer) => encoderErr.push(b));

	decoder.stdout?.pipe(encoder.stdin!);

	// If either side dies abnormally, kill the other so we don't hang.
	decoder.on("close", (code) => {
		if (code !== 0) encoder.kill("SIGTERM");
	});
	encoder.on("close", (code) => {
		if (code !== 0) decoder.kill("SIGTERM");
	});

	const waitFor = (name: string, proc: ReturnType<typeof spawn>, err: Buffer[]) =>
		new Promise<void>((resolve, reject) => {
			proc.on("error", reject);
			proc.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`${name} exited ${code}: ${Buffer.concat(err).toString().trim()}`));
			});
		});

	await Promise.all([waitFor("ffmpeg (decode)", decoder, decoderErr), waitFor("flac (encode)", encoder, encoderErr)]);
}

async function flacStoredMd5(path: string): Promise<string> {
	const { stdout } = await exec("metaflac", ["--show-md5sum", path]);
	return stdout.trim();
}

export async function fullAudioHash(path: string, algo: ParanoiaHashingAlgorithm): Promise<string> {
	// md5 uses the dedicated muxer; everything else uses the generic hash muxer.
	const fmtArgs = algo === "md5" ? ["-f", "md5"] : ["-f", "hash", "-hash", algo];
	const { stdout } = await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:a", ...fmtArgs, "-"]);
	return stdout.trim();
}

/**
 * Used on lossy files, because mp3 re-encode adds padding and with Xing or LAME headers
 * @param path - file path
 * @param algo - the hashing algorithm
 */
export async function encodedAudioHash(path: string, algo: ParanoiaHashingAlgorithm): Promise<string> {
	const { stdout } = await exec("ffmpeg", [
		"-hide_banner", "-loglevel", "error",
		"-i", path,
		"-map", "0:a",
		"-c:a", "copy",
		"-f", "streamhash", "-hash", algo,
		"-",
	]);
	return stdout.trim();
}