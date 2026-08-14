# HOW_TO

The runbook: how to lay out an album, run the pipeline end to end, and decide what to do with each kind of source you have.
For what gem-stash is and how it is built, see [README.md](README.md).

Written for macOS.

---

## What you need installed

### Node

`.nvmrc` pins `v24.19.0`.
The project runs `.ts` files directly through Node's built-in type stripping, so there is no build step and no bundler,
but it does mean Node 24 or newer is required.
With `nvm` or `fnm` installed:

```bash
nvm use     # or: fnm use
```

### The project

```bash
pnpm install
```

pnpm is the package manager.
`.npmrc` sets `ignore-scripts=true`, so no dependency's postinstall or build script runs during install.

### Media tools

Four binaries are called as child processes:
- `ffprobe` for inspection,
- `ffmpeg` for transcoding and tag rewriting,
- `flac` for archival encoding, and
- `metaflac` for editing

FLAC metadata blocks in place.

They come from two Homebrew formulae:

```bash
brew install ffmpeg flac
```

`ffprobe` ships inside `ffmpeg`, and `metaflac` ships inside `flac`.
There is no `brew install ffprobe` or `brew install metaflac`; both fail with "No available formula".

Confirm all four are on your PATH:

```bash
ffprobe -version && ffmpeg -version && flac --version && metaflac --version
```

---

## The pipeline in one screen

```
pnpm scan          inspect + classify every file, write the catalog and a quality report
pnpm process       strip each inbox file into archive/, capture tags + art to a sidecar
pnpm scaffold      consolidate the per-file sidecars into one album master per album
#   <-- you hand-edit each album.sidecar.json here
pnpm tag           write the corrected tags + front cover onto the archive files
pnpm render        transcode into renders/apple/ as ALAC m4a for Apple Music
pnpm restructure   copy the archive into final_archive/ in the artist-first layout
pnpm purge         delete the inbox sources that are proven safe
```

Every command asks for the catalog file (`./catalog.db`). Beyond that the prompts differ:
- `scan` asks for a music directory (`./work/inbox`);
- `process`, `tag`, `render`, `restructure` and `purge` ask for a work root (`./work`);
- `scaffold` asks for nothing else, because it finds the albums through the catalog.

Each command plans the work, prints a summary, and waits for an explicit confirmation before writing.
Cancel at any prompt and nothing is written.

---

## Lay out the inbox first

Album grouping comes from the folder a file sits in, so the nesting matters:

```
work/inbox/<Artist>/<Album>/<track files>
```

Example:

```
work/inbox/Fatboy Slim/You've Come a Long Way Baby/01 Right Here Right Now.wav
work/inbox/Fatboy Slim/You've Come a Long Way Baby/02 The Rockafeller Skank.wav
```

### Why the nesting matters

`process` mirrors each file's inbox subpath into `archive/<category>/`, and albums are then grouped by the directory the file landed in: one folder is one album.
The last folder in that path names the album, and whatever sits between the category root, and it names the artist.
Nest deeper and the artist label absorbs the extra levels,
so `Rottun Recordings/Vaski/Hurricane EP/` groups as artist `Rottun Recordings/Vaski`,
album `Hurricane EP`, which is still one correct album.
Tracks dropped loose in the inbox root get `(root)` for both and are tedious to sort out later.

That grouping label only decides which files share a master.
The `albumArtist` you write into the master is what Apple Music actually groups by, and you set that by hand.

### Multi-disc releases

Keep the whole release in **one** album folder and prefix the filenames `1-01`, `1-02`, `2-01`.
Do not split it into two folders.
The disc tags get set from the master later, and `render` and `restructure` rebuild the output path from those tags,
so both discs merge into a single album folder even when they arrived as two separate inbox directories.

---

## Walkthrough

For a first run, one small single-disc album is the ideal guinea pig.

### 1. `pnpm scan`

Optional, and worth doing anyway the first time.

- Music directory: `./work/inbox`
- Catalog: `./catalog.db`
- Confirm the scan
- Say yes to the report and accept the default path (`./reports/<date>-quality.md`)

It walks the directory, runs `ffprobe` on every audio file, classifies each one as lossless-cd, lossless-hires, lossy or suspect, and writes a Markdown report.
Open the report: it is your "what do I actually have" answer.

Scan writes nothing except the catalog and the report, so it is safe to re-run.
Results are cached by absolute path, which also means a file swapped in place under a path already in the catalog will not be re-probed.

You can skip straight to `process`, which does its own scan.
Running `scan` first just lets you read the verdicts before anything is written.

### 2. `pnpm process`

- Work root: `./work`
- Inbox subdir: leave empty for the whole inbox, or name a subfolder to limit the run to one album while you are testing
- Catalog: `./catalog.db`
- Verification paranoia: a five-level ladder named after Crash Bandicoot's masks

  | Choice                 | What it adds                                                          |
  |------------------------|-----------------------------------------------------------------------|
  | None - Raw Crash       | convert only, no checks                                               |
  | Verify - One Mask      | `flac --verify`, proving source PCM matches the FLAC as it encodes    |
  | Test - Two Masks       | plus `flac -t`, a decode self-check against the STREAMINFO MD5        |
  | MD5 Hash - Three Masks | plus an end-to-end decoded-audio MD5 compare of source to destination |
  | SHA256 - Invincibility | the same compare with SHA-256 (the default)                           |

  Keep the default for a real archive run. The level does not change what gets written;
  it changes how much proof you have that the copy is bit-identical, which is what makes deleting the inbox source at step 8 a decision rather than a hope.

- Review the plan summary (encodes against copies), then confirm.

For every file, `process` reads the tags and embedded art from the untouched inbox source,
writes a `<file>.sidecar.json` plus stream-copied `.artN.jpg` images next to the destination,
then produces a tag-and-art-stripped copy under `work/archive/`:

- Lossless non-FLAC (your WAV rips) is **encoded to FLAC** into `archive/lossless/`.
- FLAC is remux-copied into `archive/lossless/`, no re-encode.
- Lossy (mp3, aac) is remux-copied into `archive/lossy/`, the re-rip queue.
- Suspect files go to `archive/suspect/` for manual review.

The inbox source is never touched and nothing is deleted.
A worklist of sources that are now safe to delete is written to `./reports/safe-to-delete.txt` for step 8.

Look in `work/archive/lossless/<Artist>/<Album>/` afterward, and you will find:
the `.flac` files, the `.sidecar.json` files and the `.artN.jpg` images.
The FLACs are tagless at this point, stripped on purpose; the tags live in the sidecars.

### 3. `pnpm scaffold`

- Catalog: `./catalog.db`
- It reports how many albums have no master; confirm to create them.

This consolidates the per-file sidecars for each album into one `album.sidecar.json` in the album's folder.
Album-wide fields (album name, album artist, date, genre, compilation,totals) are lifted into an album-level block;
per-track fields (title, artist, track and disc number, front art) stay per track.

Existing masters are left alone unless you opt into the refresh, which overwrites every hand-edit in them.

### 4. Edit the album master

Open the `album.sidecar.json` that scaffold wrote. This is **the** document you edit.
Leave the per-file `<file>.sidecar.json` files alone; `tag` regenerates them from the master.

#### Sidecar shape (trimmed)

```json
{
  "schemaVersion": 1,
  "album": {
    "albumArtist": "",
    "album": "You've Come a Long Way Baby",
    "date": "1998",
    "genre": "Electronic",
    "compilation": "",
    "totalTracks": "12",
    "totalDiscs": "1",
    "albumArtistSort": ""
  },
  "tracks": [
    {
      "file": "lossless/Fatboy Slim/You've Come a Long Way Baby/01 Right Here Right Now.flac",
      "title": "Right Here, Right Now",
      "artist": "Fatboy Slim",
      "trackNumber": "1/12",
      "discNumber": "1/1",
      "frontArt": "01 Right Here Right Now.flac.art0.jpg",
      "composer": "", "artistSort": "", "comment": "", "grouping": "", "iSrc": ""
    }
  ]
}
```

The fields that decide whether Apple Music renders the album correctly:

**`albumArtist`** is uniform across the album by construction, since it is a single album-level field.
Leave it empty and `tag` prompts you, offering the track artists as quick picks plus a free-text option.
For a DJ comp the right answer is usually the compiler, not any one track artist.
This string is also what Apple matches against its own catalog to find an artist image, so pick one spelling per artist and reuse it.

**`compilation`** can stay empty and let `tag` decide.
It sets `1` only when the album has two or more distinct track artists and fewer than half of them contain the `albumArtist` string,
or when `albumArtist` is empty or begins with "Various".
So an album where the album artist performs most of the record stays off,
and a guest credit like "Seether & Van Coke Kartel" does not push an artist album into Apple's Compilations bucket.
An explicit `0` is read as a decision and left alone; set `1` yourself to force it.

**`trackNumber` / `discNumber`** take `number/total` form: `1/12`, `1/1`. Every track needs a `trackNumber`,
and no two tracks may share the same disc and track pair, or `tag` skips the album.

**`frontArt`** is the filename of the cover to embed, resolved against the folder the audio file is in.
Scaffold fills it with the first extracted image in stream order, which is not always the largest or the right one, so check it.
When the embedded art is wrong or too small, drop your own file into the album folder and point every track's `frontArt` at it.
One cover is embedded, as picture type 3 (front). JPEG and PNG both work.
Aim square: Apple renders every tile and the Now Playing view as a square and letterboxes anything else.

**`title` / `artist`** are the real per-track values.
On a comp, `artist` is whoever actually performed that track; `albumArtist` above is what groups them.

A WAV album arrives with most of these empty, and you fill them from MusicBrainz or the CD sleeve.
A rip that came in already tagged arrives mostly pre-filled and you sanity-check it.

### 5. `pnpm tag`

- Work root: `./work`
- Catalog: `./catalog.db`
- If an album's `albumArtist` is still empty it prompts. If the compilation heuristic fires, it logs that it is setting `compilation = 1`.
- Review the "ready to tag" summary, then confirm.

This writes the corrected tags and front cover onto every archive file **in place**, then reads them back to confirm what landed:

- FLAC masters are edited with `metaflac`, which rewrites only the `VORBIS_COMMENT` and `PICTURE` blocks.
  The audio frames stay byte-identical and the `STREAMINFO MD5` is unchanged.
  Your lossless masters are not re-encoded.
- Lossy and suspect files are tag-rewritten via an `ffmpeg -c:a copy` remux into a temp file that then atomically replaces the original,
  so the audio bitstream is byte-copied.

Albums with a missing track number or a duplicate disc/track pair are skipped and listed.
An empty genre is a warning, not a blocker. Each album that runs gets an Apple-ready verdict:
yes means it passed validation and every track read back clean.
Watch the log for `readback mismatch`, which is the tool telling you a tag did not land as written.

The masters are self-describing after this. Open one in any player, or check by hand:

```bash
metaflac --list --block-type=VORBIS_COMMENT "<file>.flac"
metaflac --list --block-type=PICTURE "<file>.flac"
```

### 6. `pnpm render`

This is the output you sync to the phone.

- Work root: `./work`
- Catalog: `./catalog.db`
- Verification paranoia: only three levels here (None, MD5, SHA256), defaulting to SHA256
- Overwrite renders that already exist: defaults to no, which skips them
- Confirm

It writes `work/renders/apple/<Album Artist>/<Album>/<D-TT> <Title>.m4a`.
The path is rebuilt from the master tags rather than from the archive layout, so a multi-disc release or one split across `lossless/` and `lossy/` still lands in a single album folder.

- FLAC masters are transcoded to ALAC, then decoded-audio verified against the master.
- Lossy that is already AAC is copied as-is.
- Other lossy is re-encoded to AAC at 256k.
- Suspect files are skipped.

Tags and the front cover are re-applied from the master and read back.

An album is renderable as soon as its master has an `albumArtist` and no blocking issues.
`pnpm tag` is not a prerequisite; it makes the archive masters self-describing, which `render` does not depend on.
Renders are disposable: delete `renders/apple/` and re-run it whenever you want.

#### Apple Music Copy
> ![Note] One approach
> To load it into Apple Music, first:
> - go to Settings,
> - then Files, and
> - uncheck "Copy files to Music Media folder when adding to library".
> Then add `renders/apple/`. Apple indexes the files where they are instead of duplicating and reorganizing them.

### 7. `pnpm restructure`

- Work root: `./work`
- Catalog: `./catalog.db`
- Verification paranoia: defaults to None here
- Overwrite existing files: defaults to no
- Confirm

This copies the lossless and lossy archive files into `work/final_archive/`, using the same artist-first tree as the render but keeping each file's original format.
It is a byte copy with no transcode, re-tagged from the master, so a staging name like `track01.cdda.flac` becomes `2-01 In My Mind.flac` in the right folder.
The `archive/` tree is not modified.

Paranoia defaults to None because a byte copy plus a metadata-only tag write cannot alter the audio. Raise it if you want the compare run anyway.

> [!Warning]
> `restructure` copies the audio file and embeds the one image named in `frontArt`. 
> It does not copy the extracted `.artN.*` images or the sidecar JSON.
> Those exist only under `work/archive/`.
> Copy them out before you delete that tree, or you lose every extracted image that was not the front cover.

### 8. `pnpm purge`

> [!Caution]
> This is the only step that deletes anything.

Run it only once you trust the archive.
It reads the verified inbox sources from the catalog, shows the exact list with a total size and the folder cleanup it will do, asks one explicit confirm, then unlinks.

After deleting a folder's media it sweeps the leftover non-media files (rip logs, `.cue` sheets, cover art) into the archive folder or folders that folder's media landed in,
drops dotfiles rather than copying them, and removes the emptied inbox folder, walking up while parents are empty.

For a first test, skip it entirely and delete `work/` by hand when you are done.

---

## Deciding what to do with each album

```
Lossy (mp3/aac)?          re-rip from disc if you have it, otherwise it is what it is
Lossless WAV/FLAC?        just process it; re-ripping gains nothing
No disc, no better copy?  process what you have
Flagged suspect?          re-rip if you can, otherwise inspect it by hand
```

Lossy formats permanently discarded audio data when they were encoded. Nothing downstream recovers it,
and re-encoding a lossy file to FLAC just makes the same audio bigger.
The only fix is going back to the disc.

---

## Re-ripping a CD on macOS

Use a ripper that does secure reading and AccurateRip. The two are different things and you want both:

- **Secure reading** re-reads sectors until successive reads agree and error-corrects what it can.
  `cdparanoia` is the engine everyone builds this on.
- **AccurateRip** compares a checksum of your rip against a database of rips other people made from the same pressing.
  A confirmed result tells you your copy is bit-perfect, not merely that your drive reported no errors.

Secure reading alone gets you a clean rip. AccurateRip is what turns "probably fine" into a positive confirmation,
which is the reason to re-rip at all instead of dragging tracks out of the Music app.

### Recommended: XLD

XLD (X Lossless Decoder) is the macOS equivalent of Exact Audio Copy on Windows:
a cdparanoia-derived read engine with AccurateRip verification, in one free app.

```bash
brew install --cask xld
```

Then in preferences:

- Output format: **FLAC**. Level 8 is fine; the compression level changes the file size, not the audio.
- Ripper mode: the secure mode with AccurateRip verification (XLD labels it "CDParanoia III"). Leave the secure defaults alone.
- File naming template: `%A/%T/%n %t` writes `Artist/Album/01 Title.flac`, which drops straight into the inbox layout.

Insert the disc and XLD looks the release up in MusicBrainz or CDDB and fills in artist, album and track titles.
Fix anything wrong before you rip. Those tags flow into your sidecar via `process`, so getting them right here is editing you do not do later.

When the rip finishes, XLD reports the AccurateRip result. Keep its log file next to the tracks: `purge` sweeps it into the archive folder as a leftover, so it stays with the album.

Move the result into `work/inbox/<Artist>/<Album>/`, or rip directly there, then run `pnpm process`.

### CLI alternatives

- **`cdparanoia`** (`brew install cdparanoia`) is the read engine on its own. Clean WAVs, no AccurateRip and no metadata.
  Fine if you trust the disc and will tag later, but you give up the cross-database confirmation.
- **`abcde`** (`brew install abcde`) drives cdparanoia and pulls tags from MusicBrainz, producing tagged FLAC in one command.
  Needs a `~/.abcde.conf` for FLAC output, the metadata source and a filename template. Still no AccurateRip, but fully scriptable.
- **`whipper`** is the successor to morituri and the closest CLI match to XLD: secure reading, AccurateRip, a proper rip log and MusicBrainz metadata. 
  It targets Linux, and running it on macOS means Docker rather than `brew` or `pip`.
  Worth it only if you need CLI **and** AccurateRip.

### What not to use

The Music app can import CDs, but its default AAC import is lossy, and even its Apple Lossless import does no AccurateRip verification.
Rip with XLD and let `pnpm render` produce the Apple `.m4a` copies from the verified FLAC.

### FLAC or WAV?

Rip to **FLAC**. It is bit-identical to WAV, roughly half the size, carries tags, and is what the archive stores.
If your ripper only writes WAV that is fine too: `process` encodes WAV to FLAC losslessly.
FLAC just skips the step and brings its tags along.

---

## If something looks wrong

**`No available formula with the name "ffprobe"`** during install: those binaries have no formula of their own. Run `brew install ffmpeg flac` instead.

**Tracks split across albums, or grouped under `(root)`**: the inbox nesting was off. Fix it to `Artist/Album/tracks` and re-process.
The catalog caches by path, so moving the files gives you a clean run.

**`skip-dest-exists` in the process plan**: that archive file is already there. `process` never overwrites the archive.
Delete the old destination if you meant to redo it.

**An album skipped by `tag`**: it has a blocking issue, printed with the skip.
Either a track with no `trackNumber`, or two tracks sharing a disc and track pair. Fix the master and re-run.

**`readback mismatch` after `tag`**: a tag did not land as written. Check that field in the master and in the file, then re-run `tag`.

**An album `render` calls not ready**: either its master has a blocking issue, or its `albumArtist` is empty. The skip reason names which.

**Fresh start**: delete `catalog.db`, `reports/` and `work/archive/`, and you are back to clean.
The inbox sources are untouched by everything except `purge`.
