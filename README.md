# gem-stash

A personal music catalog and CD-rip pipeline for macOS. Scan a library, record the
audio quality of every file into a SQLite catalog, convert raw rips into FLAC
archival masters and ALAC `.m4a` copies for iPhone, and restructure everything into a
clean artist-first layout with the metadata Apple Music needs to render albums
correctly on-device.

The name: gems are the collectibles of the Crash Bandicoot world, and the back of a
CD is shiny like one. This is the stash where the good copies live.

## Goals

- Know exactly what I have and at what quality, so I can tell true CD rips apart from
  old lossy rips that should be re-ripped from disc.
- Keep a single lossless source of truth (FLAC), and generate disposable copies for
  each target (Apple Music, and later the car USB) from it.
- Get the tags right so albums, including multi-artist DJ compilations, render
  correctly when synced to iPhone.

## The three tiers

1. **Archive (FLAC)**: the lossless source of truth. Bit-identical to the original
   WAV rip, about half the size, and it tags properly (WAV does not).
2. **Apple render (ALAC `.m4a`)**: lossless, Apple-native, regenerated from the FLAC
   masters. Disposable.
3. **Backup**: the FLAC archive, mirrored to cloud / Nextcloud. If the phone is lost,
   pull the FLACs and regenerate the `.m4a` copies.

WAV is already lossless, so WAV -> FLAC -> WAV is bit-identical. Lossy (AAC/MP3)
permanently discarded data and cannot be "upgraded"; only re-ripping from the disc
recovers quality.

## Working layout (gitignored)

```
work/
  inbox/        raw incoming rips, kept untouched until purge
  archive/      one clean container of all processed media
    lossless/   FLAC masters, source of truth
    lossy/      stripped lossy copies, the re-rip queue
    suspect/    stripped copies of odd files, for manual review
  renders/
    apple/      ALAC m4a in Apple-ready structure (future)
    ford/       WAV for the car USB (future)
```

`process` writes every inbox file into `archive/<category>/` (mirroring the inbox
subpath) and leaves the inbox source in place. `purge` is the only step that deletes
anything. Only code, the SQLite catalog, and the generated reports are committed; the
`work/` tree is not.

## Folder convention

```
<Album Artist>/<Album>/<D-TT> <Track Title>.<ext>
```

Artist-first always. Compilers (e.g. `DJ Fresh (ZA)`) are treated as the album artist
so their comps file under their name. Multi-disc releases stay as one album folder
with `1-01`, `2-01` prefixes and correct disc tags.

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

`process` is one self-contained step per inbox file: it reads the tags and embedded
art from the untouched source, writes them into a hand-editable `<file>.sidecar.json`
plus stream-copied art images, then produces a tag-and-art-stripped copy under
`archive/<category>/`. Lossless non-FLAC is encoded to FLAC; FLAC, lossy, and suspect
files are remux-copied (`-c:a copy`, no re-encode). Nothing that arrived with a file
is ever lost, and the inbox source stays put until `purge`.

`scaffold` then consolidates the per-file sidecars into one hand-edited
`album.sidecar.json` master per album, and `tag` writes the corrected Apple-critical
tags plus a front cover onto every archive file in place (FLAC via `metaflac` with
the audio untouched, others via an `ffmpeg -c:a copy` remux), reads them back to
confirm, and records a per-album Apple-ready verdict. The master stays the editable
source of truth.

From the master, two output steps re-apply the tags explicitly: `render` produces
the Apple `renders/apple/` tree (lossless FLAC transcoded to ALAC, lossy transcoded
to AAC, verified against the master), and `restructure` produces `final_archive/`,
the same artist-first `<Album Artist>/<Album>/<D-TT> <Title>` tree but keeping each
file's original format (a byte copy, no transcode). Both merge a multi-disc or
lossless/lossy-split release into one album folder, so a raw `track01.cdda.flac`
becomes `2-01 In My Mind.flac` in the right place.

## Apple Music notes

- In Apple Music, Settings -> Files -> uncheck "Copy files to Music Media folder when
  adding to library", then add `renders/apple/`. Apple indexes the files in place
  instead of duplicating and reorganizing them.
- On-phone display comes from tags, not folders. Folder structure is for humans and
  for the car head unit (which reads folders); Apple Music reads metadata.
- The `compilation` flag is a boolean stored as `1`. Set it on DJ comps so Apple
  groups multi-artist albums under the album artist instead of splitting them.

## Stack

- TypeScript / Node 24 (run via Node's built-in type stripping; no build step).
- pnpm (install with build scripts disabled via `.npmrc`).
- `@clack/prompts` for CLI interaction.
- `node:sqlite` (built into Node) for the catalog; Markdown for reports
  (Notion- and Bear-friendly).
- `ffprobe` for inspection; `flac` + `metaflac` for archival encode and
  verification; `ffmpeg` as a decode pipe for sources `flac` can't read
  directly (ALAC in m4a, etc.).

## Commands

- `pnpm scan` walks a directory, runs ffprobe per audio file (cached by
  absolute path so re-runs are free), records verdict + tags + stream info in
  SQLite, and writes a Markdown quality report.
- `pnpm process` plans the inbox, shows a plan summary, asks to confirm, then
  executes. For every file it captures a `<file>.sidecar.json` plus stream-copied
  art from the untouched source, then writes a tag-and-art-stripped copy under
  `archive/<category>/`: lossless non-FLAC is encoded to FLAC, while FLAC, lossy,
  and suspect files are remux-copied (`-c:a copy`, no re-encode). A selectable
  verification paranoia level, from "no checks" up to a full end-to-end SHA-256
  audio compare, gates which sources are proven byte-identical; computed hashes
  are stored in the catalog. Sources proven safe (paranoia at or above
  `flac --verify`) get listed in `./reports/safe-to-delete.txt`. The inbox source
  is never touched; nothing is auto-deleted.
- `pnpm scaffold` consolidates the per-file sidecars for each album into a single
  hand-edited `album.sidecar.json` master (album-wide fields lifted out, per-track
  fields kept per track). Existing masters are left alone unless you opt into a
  refresh.
- `pnpm tag` validates each album (prompting for a missing album artist, auto-setting
  the compilation flag when track artists vary), writes the Apple-critical tags plus
  front cover onto every archive file in place, reads the tags back to confirm, and
  records a per-album Apple-ready verdict. FLAC masters are edited with `metaflac`
  (audio frames untouched); lossy and suspect files are tag-rewritten via `ffmpeg
  -c:a copy`.
- `pnpm render` builds the Apple output under `renders/apple/` in an artist-first,
  one-folder-per-album tree. Lossless FLAC is transcoded to ALAC, lossy is transcoded
  to AAC (copied as-is when already AAC, else re-encoded at 256k), suspect is skipped.
  Tags + front cover are re-applied from the master and read back; the ALAC transcode
  is decoded-audio verified against its FLAC master.
- `pnpm restructure` copies the lossless + lossy archive files into `final_archive/`
  in the same artist-first tree, keeping each file's original format (a byte copy, no
  transcode), re-tagged from the master. The staging `archive/` tree is never touched.
- `pnpm discogs` downloads Discogs release JSON to `./discogs/` for the releases you
  list in `tools/discogs-urls.txt`, using a `DISCOGS_TOKEN` (proper User-Agent, rate
  limiting, retries). `pnpm discogs-apply <release.json> <album.sidecar.json>` then
  applies that JSON onto a sidecar with Discogs as the source of truth (positional
  track map with a count guard). Both live in `tools/`.
- `pnpm purge` reads the verified, processed sources from the catalog, shows the
  list with sizes plus the folder-cleanup it will do, asks one explicit confirm,
  then unlinks. After deleting a folder's media sources it sweeps the leftover
  non-media files (cdparanoia.log, .cue, cover art) into the destination
  folder(s) their media went to and removes the emptied inbox folder; dotfiles
  are dropped. Failed unlinks keep their catalog pointer so a retry will find
  them. This is the only destructive step in the pipeline.
- `pnpm typecheck` runs `tsc --noEmit`.

## Status

**MVP complete and proven end-to-end on a real album.** The whole chain runs:
`scan -> process -> scaffold -> (fill sidecars) -> tag -> render`, with `restructure`
producing the final artist-first archive. It was verified on a real 2-disc DJ
compilation (Fresh Goes Electro Vol. 2): both discs merge into one Apple-grouped
album, the tags read back clean, and the ALAC renders decode bit-identical to their
FLAC masters. `renders/apple/` is ready to add to Apple Music and sync to iPhone.

The remaining work is polish before a public release, plus the two optional later
milestones (a WAV render for the car USB, and a possible Go port). See the roadmap
below and `CLAUDE.md` for the polish checklist.

The catalog lives at `./catalog.db`; reports live under `./reports/`. See `CLAUDE.md`
for the catalog schema, code layout, and key gotchas (camelCase columns, path-keyed
scan cache, atomic FLAC writes, and the Node enum note), and `NEXT_STEPS.md` +
`HOW_TO.md` for the current state and the run-it-yourself walkthrough.

## Roadmap

- [x] Scanner and quality catalog.
- [x] Markdown quality report with per-album tag validation (uniform album
      artist, compilation flag present).
- [x] FLAC conversion stage (inbox -> archive) with a selectable paranoia ladder
      (`flac --verify`, `flac -t`, decoded-audio MD5/SHA-256 compare), opt-in
      source purge.
- [x] Lossy holding area (`archive/lossy`) as a re-rip worklist.
- [x] Metadata + art extraction into per-file sidecars, folded into `pnpm process`
      with an audio-preserving strip for every category. Verified on a real sample.
- [x] Tag writing: `pnpm scaffold` builds a per-album `album.sidecar.json` master
      from the per-file sidecars; `pnpm tag` writes the Apple-critical tags + front
      cover onto every archive file in place (FLAC via `metaflac`, others via
      `ffmpeg -c:a copy`), reads back, and records a per-album Apple-ready verdict.
      Verified on a real album.
- [x] ALAC `.m4a` render stage (`pnpm render`), re-applying the tags from the album
      master, ALAC for lossless and AAC for lossy. **The MVP: the iPhone output.**
- [x] Final archive restructure (`pnpm restructure`) into the artist-first layout
      using tags as the source of truth, keeping original formats. (Milestone 4.5,
      needed so the archive itself is human-correct, not only the renders.)
- [x] Repeatable Discogs metadata into sidecars (`pnpm discogs` + `pnpm
      discogs-apply`, in `tools/`). (Milestone 4.75, needed to fill tag-less rips.)
- [ ] Pre-release polish (see the checklist in `CLAUDE.md`).
- [ ] WAV render for the car USB.
- [ ] Possible later port to Go for cross-system use.
