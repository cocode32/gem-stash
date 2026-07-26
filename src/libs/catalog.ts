import { DatabaseSync } from "node:sqlite";
import type { Category, Verdict } from "./classify.ts";

export type FileRow = {
	path: string;
	relativePath: string;
	albumArtistFolder: string | null;
	albumFolder: string | null;
	filename: string;
	codec: string;
	channels: number;
	sampleRate: number;
	bitsPerChannel: number | null;
	bitRate: number | null;
	durationSeconds: number | null;
	verdict: Verdict;
	inspector: string;
	tagAlbumArtist: string | null;
	tagArtist: string | null;
	tagAlbum: string | null;
	tagTitle: string | null;
	tagTrack: string | null;
	tagDisc: string | null;
	tagDate: string | null;
	tagGenre: string | null;
	tagCompilation: string | null;
	scannedAt: string;
	error: string | null;
	state: FileState | null;
	originalPath: string | null;
	verified: number | null;
	verifyMd5Source: string | null;
	verifyMd5Dest: string | null;
	verifyAudioMd5: string | null;
	verifyAudioSha256: string | null;
	processedAt: string | null;
	sidecarPath: string | null;
	artPaths: string | null;
	droppedTagKeys: string | null;
	tagsExtractedAt: string | null;
	detaggedAt: string | null;
	appleReady: number | null;
	taggedAt: string | null;
	tagIssues: string | null;
	albumSidecarPath: string | null;
};

// 'inbox' = raw, not yet processed; the rest mirror the archive/ subfolders.
export type FileState = "inbox" | Category;

export function openCatalog(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	// Single base table, no migrations.
	// The catalog is rebuilt from scratch each run during development, so every column lives here and is either populated or NULL.
	// If a long-lived catalog ever becomes a thing, reintroduce a migrate() step rather than editing this in place.
	db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      relativePath TEXT NOT NULL,
      albumArtistFolder TEXT,
      albumFolder TEXT,
      filename TEXT NOT NULL,
      codec TEXT,
      channels INTEGER,
      sampleRate INTEGER,
      bitsPerChannel INTEGER,
      bitRate INTEGER,
      durationSeconds REAL,
      verdict TEXT NOT NULL,
      inspector TEXT,
      tagAlbumArtist TEXT,
      tagArtist TEXT,
      tagAlbum TEXT,
      tagTitle TEXT,
      tagTrack TEXT,
      tagDisc TEXT,
      tagDate TEXT,
      tagGenre TEXT,
      tagCompilation TEXT,
      scannedAt TEXT NOT NULL,
      error TEXT,
      state TEXT,
      originalPath TEXT,
      verified INTEGER,
      verifyMd5Source TEXT,
      verifyMd5Dest TEXT,
      verifyAudioMd5 TEXT,
      verifyAudioSha256 TEXT,
      processedAt TEXT,
      sidecarPath TEXT,
      artPaths TEXT,
      droppedTagKeys TEXT,
      tagsExtractedAt TEXT,
      detaggedAt TEXT,
      appleReady INTEGER,
      taggedAt TEXT,
      tagIssues TEXT,
      albumSidecarPath TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_files_album
      ON files(albumArtistFolder, albumFolder);
    CREATE INDEX IF NOT EXISTS idx_files_state ON files(state);
    CREATE INDEX IF NOT EXISTS idx_files_originalPath ON files(originalPath);
  `);
	return db;
}

const UPSERT_SQL = `
  INSERT INTO files (
    path, relativePath, albumArtistFolder, albumFolder, filename,
    codec, channels, sampleRate, bitsPerChannel, bitRate, durationSeconds,
    verdict, inspector,
    tagAlbumArtist, tagArtist, tagAlbum, tagTitle, tagTrack, tagDisc,
    tagDate, tagGenre, tagCompilation,
    scannedAt, error
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?
  )
  ON CONFLICT(path) DO UPDATE SET
    relativePath       = excluded.relativePath,
    albumArtistFolder  = excluded.albumArtistFolder,
    albumFolder        = excluded.albumFolder,
    filename           = excluded.filename,
    codec              = excluded.codec,
    channels           = excluded.channels,
    sampleRate         = excluded.sampleRate,
    bitsPerChannel     = excluded.bitsPerChannel,
    bitRate            = excluded.bitRate,
    durationSeconds    = excluded.durationSeconds,
    verdict            = excluded.verdict,
    inspector          = excluded.inspector,
    tagAlbumArtist     = excluded.tagAlbumArtist,
    tagArtist          = excluded.tagArtist,
    tagAlbum           = excluded.tagAlbum,
    tagTitle           = excluded.tagTitle,
    tagTrack           = excluded.tagTrack,
    tagDisc            = excluded.tagDisc,
    tagDate            = excluded.tagDate,
    tagGenre           = excluded.tagGenre,
    tagCompilation     = excluded.tagCompilation,
    scannedAt          = excluded.scannedAt,
    error              = excluded.error
`;

export function upsertFile(db: DatabaseSync, r: FileRow): void {
	db.prepare(UPSERT_SQL).run(
		r.path,
		r.relativePath,
		r.albumArtistFolder,
		r.albumFolder,
		r.filename,
		r.codec,
		r.channels,
		r.sampleRate,
		r.bitsPerChannel,
		r.bitRate,
		r.durationSeconds,
		r.verdict,
		r.inspector,
		r.tagAlbumArtist,
		r.tagArtist,
		r.tagAlbum,
		r.tagTitle,
		r.tagTrack,
		r.tagDisc,
		r.tagDate,
		r.tagGenre,
		r.tagCompilation,
		r.scannedAt,
		r.error,
	);
}

export function findByPath(db: DatabaseSync, path: string): FileRow | undefined {
	return db.prepare(`SELECT * FROM files WHERE path = ?`).get(path) as FileRow | undefined;
}

export function findByOriginalPath(db: DatabaseSync, originalPath: string): FileRow | undefined {
	return db.prepare(`SELECT * FROM files WHERE originalPath = ?`).get(originalPath) as FileRow | undefined;
}

export type ConversionHashes = {
	/**
	 * libFLAC STREAMINFO PCM MD5 (paranoia >= Test).
	 * Stored in both verifyMd5 columns: flac --verify proved source PCM == output PCM,
	 * so the one hash is legitimately both the source and dest MD5.
	 */
	streamInfoMd5: string | null;
	/**
	 * ffmpeg decoded-audio compare hashes, proven equal source vs flac.
	 */
	audioMd5: string | null;
	/**
	 * ffmpeg decoded-audio compare hashes, proven equal source vs flac.
	 */
	audioSha256: string | null;
};

/**
 * Records a processed file: an encode (lossless non-FLAC -> FLAC) or a remux copy (FLAC/lossy/suspect stripped of tags + art).
 * The row's path moves to the destination in archive/<state>/;
 * the inbox source stays on disk and originalPath remembers it so purge can offer it for deletion.
 * `verified` gates the safe-to-delete worklist;
 * the caller passes true once the destination is produced (the encode/remux throws
 * on any verification failure, and Paranoia.None trusts the copy without checks),
 * so a recorded file is always safe to delete.
 *
 * @param db The catalog db source
 * @param srcPath The source file
 * @param destPath The destination target file
 * @param destRelative The relative path to the destination file
 * @param state The state to store
 * @param verified The verified status
 * @param hashes An object of hashes computed
 */
export function recordProcessed(
	db: DatabaseSync,
	srcPath: string,
	destPath: string,
	destRelative: string,
	state: Category,
	verified: boolean,
	hashes: ConversionHashes,
): void {
	db.prepare(
		`UPDATE files
     SET path = ?,
         relativePath = ?,
         state = ?,
         originalPath = ?,
         verified = ?,
         verifyMd5Source = ?,
         verifyMd5Dest = ?,
         verifyAudioMd5 = ?,
         verifyAudioSha256 = ?,
         processedAt = ?
     WHERE path = ?`,
	).run(
		destPath,
		destRelative,
		state,
		srcPath,
		verified ? 1 : 0,
		hashes.streamInfoMd5,
		hashes.streamInfoMd5,
		hashes.audioMd5,
		hashes.audioSha256,
		new Date().toISOString(),
		srcPath,
	);
}

export type ExtractionRecord = {
	/**
	 * absolute path to the written sidecar JSON
	 */
	sidecarPath: string;
	/**
	 * filenames (relative to the audio file's directory) of extracted art images
	 */
	artFiles: string[];
	/**
	 * raw tag keys that did not map to a canonical field
	 */
	droppedKeys: string[];
	/**
	 * set when the lossy file itself was de-tagged (audio-preserving strip)
	 */
	detagged: boolean;
};

/**
 * Records that metadata + art were captured for a file.
 * Stores the art file list and dropped-key log as JSON arrays.
 * `detaggedAt` is only set for lossy files whose tags were stripped after extraction.
 * @param db The catalog database
 * @param path The path identifier of the row
 * @param rec Extraction information
 */
export function recordExtraction(db: DatabaseSync, path: string, rec: ExtractionRecord): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE files
     SET sidecarPath = ?,
         artPaths = ?,
         droppedTagKeys = ?,
         tagsExtractedAt = ?,
         detaggedAt = ?
     WHERE path = ?`,
	).run(rec.sidecarPath, JSON.stringify(rec.artFiles), JSON.stringify(rec.droppedKeys), now, rec.detagged ? now : null, path);
}

/**
 * Worklist for purge: verified, processed sources that may still be on disk.
 * The state guard is defensive (a verified row always has a category state),
 * but it makes "only files that landed in archive/ are deletable" explicit.
 * The caller filters out paths that no longer exist before showing the deletion list.
 *
 * @param db The catalog db
 */
export function findVerifiedSafeToDelete(db: DatabaseSync): FileRow[] {
	return db
		.prepare(
			`SELECT * FROM files
       WHERE verified = 1
         AND originalPath IS NOT NULL
         AND state IN ('lossless', 'lossy', 'suspect')
       ORDER BY originalPath`,
		)
		.all() as FileRow[];
}

export function clearPurged(db: DatabaseSync, originalPaths: string[]): void {
	const stmt = db.prepare(`UPDATE files SET originalPath = NULL WHERE originalPath = ?`);
	for (const p of originalPaths) stmt.run(p);
}

export function allRows(db: DatabaseSync): FileRow[] {
	return db.prepare(`SELECT * FROM files ORDER BY path`).all() as FileRow[];
}

/**
 * Every processed file (landed in an `archive/` bucket),
 * ordered by its archive path so callers can group by album folder.
 * This is the input set for the milestone-3 tag writer:
 *  - lossless,
 *  - lossy, and
 *  - suspect
 *  are all tagged.
 *
 * @param db The catalog db
 */
export function findProcessed(db: DatabaseSync): FileRow[] {
	return db
		.prepare(
			`SELECT * FROM files
       WHERE state IN ('lossless', 'lossy', 'suspect')
       ORDER BY relativePath`,
		)
		.all() as FileRow[];
}

/**
 * The final tag state actually written onto a file,
 * mirrored into the existing `tag*` columns
 * so reports keep reading one place.
 * track/disc are the combined `n/total` forms.
 */
export type FinalTags = {
	albumArtist: string;
	artist: string;
	album: string;
	title: string;
	track: string;
	disc: string;
	date: string;
	genre: string;
	compilation: string;
};

export type TaggedRecord = {
	finalTags: FinalTags;
	/**
	 * Per-album verdict: did this album pass validation AND every readback?
	 * Stored on every track of the album so a single row answers
	 * "is this album safe to render for Apple".
	 */
	appleReady: boolean;
	/**
	 * For the report
	 *  - Validation warnings, and
	 *  - Readback mismatches.
	 *
	 * Empty when clean.
	 */
	issues: string[];
	/**
	 * Absolute path to the album master sidecar this row was tagged from.
	 */
	albumSidecarPath: string;
};

/**
 * Record that authoritative tags were written onto a file.
 *  - Refreshes the `tag*` columns with what was actually written,
 *  - Stamps the Apple-ready verdict,
 *  - The issue log, and
 *  - The album master path.
 *
 * @param db The catalog db
 * @param path The file's archive path (row identity)
 * @param rec The tag-write result
 */
export function recordTagged(db: DatabaseSync, path: string, rec: TaggedRecord): void {
	db.prepare(
		`UPDATE files
     SET tagAlbumArtist = ?,
         tagArtist = ?,
         tagAlbum = ?,
         tagTitle = ?,
         tagTrack = ?,
         tagDisc = ?,
         tagDate = ?,
         tagGenre = ?,
         tagCompilation = ?,
         appleReady = ?,
         taggedAt = ?,
         tagIssues = ?,
         albumSidecarPath = ?
     WHERE path = ?`,
	).run(
		rec.finalTags.albumArtist || null,
		rec.finalTags.artist || null,
		rec.finalTags.album || null,
		rec.finalTags.title || null,
		rec.finalTags.track || null,
		rec.finalTags.disc || null,
		rec.finalTags.date || null,
		rec.finalTags.genre || null,
		rec.finalTags.compilation || null,
		rec.appleReady ? 1 : 0,
		new Date().toISOString(),
		rec.issues.length > 0 ? JSON.stringify(rec.issues) : null,
		rec.albumSidecarPath,
		path,
	);
}
