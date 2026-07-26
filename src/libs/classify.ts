import type { StreamInfo } from "./inspect.ts";
import { LOSSLESS_CODECS, LOSSY_CODECS } from "../common/codecs.ts";

export type Verdict = "lossless-cd" | "lossless-hires" | "lossy" | "suspect";

/**
 * Storage bucket a file lands in under archive/.
 * Collapses the two lossless verdicts into one folder;
 * lossy and suspect map straight through.
 * This is the subfolder name in archive/ and the post-process `state` in the catalog.
 */
export type Category = "lossless" | "lossy" | "suspect";

export function categoryFor(verdict: Verdict): Category {
	if (verdict === "lossy") return "lossy";
	if (verdict === "suspect") return "suspect";
	return "lossless";
}

export function classify(s: StreamInfo): Verdict {
	const codec = s.codec.trim().toLowerCase();

	if (LOSSY_CODECS.has(codec)) return "lossy";

	const isLossless = LOSSLESS_CODECS.has(codec) || codec.startsWith("pcm");
	if (!isLossless) return "suspect";

	if (s.channels !== 2) return "suspect";
	if (s.sampleRate < 44100) return "suspect";
	if (!s.bitsPerChannel || s.bitsPerChannel < 16) return "suspect";

	if (s.bitsPerChannel === 16 && s.sampleRate === 44100) return "lossless-cd";
	if (s.bitsPerChannel > 16 || s.sampleRate > 44100) return "lossless-hires";

	return "suspect";
}
