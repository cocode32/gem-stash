import { join } from "node:path";
import type { AlbumCommon, AlbumTrack } from "./album-sidecar.ts";

/**
 * The artist-first relative path for a track, derived from the album master
 * tags (the source of truth) rather than the archive layout:
 *
 *   <AlbumArtist>/<Album>/<D-TT> <Title>.<ext>
 *
 * so a split or multi-disc album still lands in one folder. `ext` is the output
 * extension without a leading dot: 'm4a' for the Apple render, or the source
 * file's own extension for the final-archive restructure (which keeps formats).
 *
 * NOTE: render.ts still has an equivalent private `renderRelPath`; fold it onto
 * this in the tidy pass (kept separate for now so the render test is untouched).
 */
export function albumRelPath(album: AlbumCommon, track: AlbumTrack, ext: string): string {
	const artist = sanitizeSegment(album.albumArtist) || "Unknown Artist";
	const albumName = sanitizeSegment(album.album) || "Unknown Album";
	const disc = track.discNumber.trim() || "1";
	const num = pad2(track.trackNumber.trim());
	const title = sanitizeSegment(track.title) || "Untitled";
	return join(artist, albumName, `${disc}-${num} ${title}.${ext}`);
}

/** Zero-pad a track number to two digits; pass non-numeric values through. */
export function pad2(n: string): string {
	const i = parseInt(n, 10);
	return Number.isFinite(i) ? String(i).padStart(2, "0") : n || "00";
}

/**
 * Strip characters that are illegal or troublesome in filenames on macOS and on
 * FAT (the future car USB): path separators, the reserved Windows set, control
 * chars, and trailing dots/spaces.
 */
export function sanitizeSegment(s: string): string {
	return (
		s
			// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit control characters used as part of sanitizing the input
			.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-")
			.replace(/\s+/g, " ")
			.replace(/[. ]+$/g, "")
			.trim()
	);
}
