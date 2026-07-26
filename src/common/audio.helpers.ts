import { execFileSync } from "node:child_process";
import { FLAC_NATIVE_CODECS } from "./codecs.ts";

/**
 * Returns the audio codec of the first audio stream, e.g. 'pcm_s16le', 'alac', 'aac'.
 * Reads the actual bytes via ffprobe rather than trusting the file extension.
 */
export function detectAudioCodec(srcPath: string): string | null {
	try {
		const out = execFileSync(
			"ffprobe",
			["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", srcPath],
			{ encoding: "utf8" },
		).trim();
		return out || null;
	} catch {
		return null; // unreadable / not audio; caller decides how to handle
	}
}

export function flacCanReadDirectly(codec: string | null): boolean {
	return codec !== null && FLAC_NATIVE_CODECS.has(codec);
}
