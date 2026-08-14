# gem-stash

A personal music catalog and CD-rip pipeline for macOS.
Scan a library, record the audio quality of every file into a SQLite catalog,
convert raw rips into FLAC archival masters and ALAC `.m4a` copies for iPhone,
and restructure everything into a clean artist-first layout with the metadata Apple Music needs to render albums correctly on-device.

The name: gems are the collectibles of the Crash Bandicoot world, and the back of a CD is shiny like one.
This is the stash where the good copies live.

To install it and run it, see [HOW_TO.md](HOW_TO.md).

## Goals

- Know exactly what I have and at what quality, so I can tell true CD rips apart from old lossy rips that should be re-ripped from disc.
- Keep a single lossless source of truth (FLAC), and generate disposable copies for each target from it.
- Get the tags right so albums, including multi-artist DJ compilations, render correctly when synced to iPhone.

## The three tiers

1. **Archive (FLAC)**: the lossless source of truth.
   Bit-identical to the original WAV rip, about half the size, and it tags properly (WAV does not).
2. **Apple render (ALAC `.m4a`)**: lossless, Apple-native, regenerated from the FLAC masters. Disposable.
3. **Backup**: the FLAC archive, mirrored to cloud storage.
   If the phone is lost, pull the FLACs and regenerate the `.m4a` copies.

WAV is already lossless, so WAV to FLAC to WAV is bit-identical.
Lossy formats (AAC, MP3) discarded audio data when they were encoded, and nothing downstream recovers it.
Re-encoding a lossy file to FLAC just makes the same audio bigger.
Only re-ripping from the disc gets the quality back.

## Working layout

The whole `work/` tree is `gitignored`.

```
work/
  inbox/          raw incoming rips, kept untouched until purge
  archive/        one clean container of all processed media
    lossless/     FLAC masters, source of truth
    lossy/        stripped lossy copies, the re-rip queue
    suspect/      stripped copies of odd files, for manual review
  renders/
    apple/        ALAC m4a in Apple-ready structure
    ford/         WAV for the car USB (not built yet)
  final_archive/  the archive in the artist-first layout, original formats kept
```

`process` writes every inbox file into `archive/<category>/`, mirroring the inbox subpath, and leaves the inbox source in place.
`purge` is the only step that deletes anything.
Only the code, the SQLite catalog and the generated reports are committed.

## Folder convention

```
<Album Artist>/<Album>/<D-TT> <Track Title>.<ext>
```

Artist-first always.
Compilers (for example `DJ Fresh (ZA)`) are treated as the album artist so their comps file under their name rather than in a separate Compilations bucket.
Multi-disc releases stay as one album folder with `1-01`, `2-01` prefixes and correct disc tags.

## Pipeline

```
scan  ->  process  ->  scaffold  ->  (fill sidecars)  ->  tag  ->  render / restructure   ( ->  purge)

inbox  --process------->  archive/lossless (FLAC)   + sidecar + art
                          archive/lossy             + sidecar + art
                          archive/suspect           + sidecar + art
archive  --render------>  renders/apple   (ALAC for lossless, AAC for lossy; Apple-ready)
         --restructure->  final_archive   (artist-first, original formats kept)
         --future------>  renders/ford    (WAV for the car USB)
```

`process` is one self-contained step per inbox file.
It reads the tags and embedded art from the untouched source,
writes them into a hand-editable `<file>.sidecar.json` plus stream-copied art images,
then produces a tag-and-art-stripped copy under `archive/<category>/`.
Lossless non-FLAC is encoded to FLAC; FLAC, lossy and suspect files are remux-copied (`-c:a copy`, no re-encode).
Every tag and every embedded image that arrived with a file is written to disk before the file is stripped, and the inbox source stays put until `purge`.

`scaffold` then consolidates the per-file sidecars into one hand-edited `album.sidecar.json` master per album,
and `tag` writes the corrected Apple-critical tags plus a front cover onto every archive file in place
(FLAC via `metaflac` with the audio frames untouched, others via an `ffmpeg -c:a copy` remux),
reads them back to confirm, and records a per-album Apple-ready verdict.
The master stays the editable source of truth.

From the master, two output steps re-apply the tags explicitly.
`render` produces the Apple `renders/apple/` tree, transcoding FLAC to ALAC and lossy to AAC, verified against the master.
`restructure` produces `final_archive/`, the same artist-first tree but keeping each file's original format as a byte copy.
Both build the output path from the master tags rather than from the archive layout,
so a multi-disc release, or one split across `lossless/` and `lossy/`, merges into a single album folder
and a staging name like `track01.cdda.flac` becomes `2-01 In My Mind.flac`.

## Apple Music notes

- In Apple Music, go to Settings, then Files, and uncheck "Copy files to Music Media folder when adding to library" before you add `renders/apple/`.
  Apple then indexes the files where they are instead of duplicating and reorganizing them.
- On-phone display comes from tags, not folders.
  The folder structure is for humans and for the car head unit, which reads folders; Apple Music reads metadata.
- `albumArtist` is the only field Apple groups the Artists view by.
  `albumArtistSort` reorders that list but never merges two entries, so filing two spellings under one name is always an `albumArtist` change.
- The `compilation` flag is a boolean stored as `1`.
  Set it on DJ comps so Apple groups a multi-artist album under its album artist instead of splitting it into per-track artists.

## Stack

- TypeScript on Node 24, run through Node's built-in type stripping. No build step.
- pnpm, with `.npmrc` setting `ignore-scripts=true` so no dependency `postinstall script` runs.
- `@clack/prompts` for CLI interaction.
- `node:sqlite`, built into Node, for the catalog. No native build and no install scripts.
- Markdown for reports, which import cleanly into Notion and Bear.
- `ffprobe` for inspection, `flac` and `metaflac` for archival encode and verification,
  and `ffmpeg` as a decode pipe for sources `flac` cannot read directly, such as ALAC in m4a.

## Commands

**`pnpm scan`** walks a directory,
runs ffprobe per audio file, records the verdict, tags and stream info in SQLite, and writes a Markdown quality report.
Results are cached by absolute path, so re-runs skip files already in the catalog.

**`pnpm process`** plans the inbox, shows a summary, asks to confirm, then executes.
For every file it captures a `<file>.sidecar.json` plus stream-copied art from the untouched source,
then writes a tag-and-art-stripped copy under `archive/<category>/`:
lossless non-FLAC is encoded to FLAC, while FLAC, lossy and suspect files are remux-copied.
A selectable paranoia level, from no checks up to an end-to-end SHA-256 decoded-audio compare,
decides how much proof the run produces that the copy is bit-identical, and stores the hashes it computed in the catalog.
Every source whose destination was produced successfully is listed in `./reports/safe-to-delete.txt`.
The inbox source is never touched and nothing is auto-deleted.

**`pnpm scaffold`** consolidates the per-file sidecars for each album into a single hand-edited `album.sidecar.json` master,
lifting album-wide fields out and keeping per-track fields per track.
Existing masters are left alone unless you opt into a refresh, which overwrites hand-edits.

**`pnpm tag`** validates each album, prompting for a missing album artist and setting the compilation flag where the heuristic fires,
writes the Apple-critical tags plus front cover onto every archive file in place,
reads the tags back to confirm, and records a per-album Apple-ready verdict.
FLAC masters are edited with `metaflac`, which rewrites only the `VORBIS_COMMENT` and `PICTURE` blocks and leaves the audio frames and the `STREAMINFO MD5` unchanged.
Lossy and suspect files are tag-rewritten via `ffmpeg -c:a copy`.

**`pnpm render`** builds the Apple output under `renders/apple/` in an artist-first, one-folder-per-album tree.
FLAC is transcoded to ALAC, lossy that is already AAC is copied as-is, other lossy is re-encoded to AAC at 256k, and suspect files are skipped.
Tags and front cover are re-applied from the master and read back, and the ALAC transcode is decoded-audio verified against its FLAC master.

**`pnpm restructure`** copies the lossless and lossy archive files into `final_archive/` in the same artist-first tree,
keeping each file's original format as a byte copy with no transcode, re-tagged from the master.
The staging `archive/` tree is never touched.

**`pnpm purge`** reads the verified, processed sources from the catalog,
shows the list with sizes plus the folder cleanup it will do, asks one explicit confirm, then unlinks.
After deleting a folder's media sources it sweeps the leftover non-media files (rip logs, `.cue` sheets, cover art)
into the destination folders their media went to and removes the emptied inbox folder; dotfiles are dropped.
Failed unlinks keep their catalog pointer so a retry finds them.
This is the only destructive step in the pipeline.

**`pnpm typecheck`** runs `tsc --noEmit`. There is no build, so this is the only compile-time check.

## Status

The full chain runs: `scan -> process -> scaffold -> (fill sidecars) -> tag -> render`, with `restructure` producing the final artist-first archive.
It was verified on a real 2-disc DJ compilation (Fresh Goes Electro Vol. 2), which arrived as two separate inbox folders:
both discs merged into one Apple-grouped album, the tags read back clean, and the ALAC renders decode bit-identical to their FLAC masters.
`renders/apple/` is ready to add to Apple Music and sync to iPhone.

The catalog lives at `./catalog.db` and reports live under `./reports/`.
See [HOW_TO.md](HOW_TO.md) for the run-it-yourself walkthrough.

## Future work

I have thought about rewriting this in Go, mostly so it runs on more than my Mac without a Node install.
That is a thought and not a plan.

My own collection is basically done, which was the point of building it,
so the Node version is where this stays for now.
The WAV render for the car USB is the one piece I never got to, and I will build it when I want it.

## License

GPL-3.0. See [LICENSE](LICENSE).

## Thanks

This was built to solve one person's problem with one music collection.
If it turns out to be useful for yours, thanks for giving it a run.
