# HOW_TO

The hands-on runbook. How to lay out an album, run the pipeline end to end, and decide what to do with the different kinds of source you have.

Written to be followed on a Mac.

---

## Installation

### Build and runtime tools

There is a `.nvmrc` file which drives the node version of this application. Ensure you have the correct version installed.
Making use of `nvm` or `fnm` is recommended.

### Media tools

Ensure the following tools are installed. You can install them with `brew`

- ffprobe
- ffmpeg
- flac
- metaflac

To install them in a single command run:

```bash
brew install ffprobe ffmpeg flac metaflac
```

## Running this application

### Quick overview

```
pnpm scan       # inspect + classify every file, write the catalog + a quality report
pnpm process    # strip each inbox file into archive/, capture tags + art to a sidecar
pnpm scaffold   # consolidate the per-file sidecars into one album master per album
#   <-- you hand-edit each album.sidecar.json here
pnpm tag        # write the corrected tags + front cover onto the archive files
pnpm purge      # (optional) delete the inbox sources that are proven safe
```

Every command prompts for a work root (default `./work`) and a catalog file (default `./catalog.db`), plans the work,
shows a summary, and waits for an explicit confirmation before writing anything.
You can cancel at any prompt.

## Gather your media files

> [!Note]
> Album grouping is derived from the folder structure, so this matters. Inside `work/inbox/`, use:
> ```
> work/inbox/<Artist>/<Album>/<track files>
> ```

Example:

```
work/inbox/Fatboy Slim/You've Come a Long Way Baby/01 Right Here Right Now.wav
work/inbox/Fatboy Slim/You've Come a Long Way Baby/02 The Rockafeller Skank.wav
...
```

### Why?
`process` computes each file's album-artist folder from the first path segment and album folder from the second (relative to the inbox path you point at).
Tracks dropped loose in the inbox root get grouped under `(root)` and are annoying to tag.
Nest them properly and the grouping is automatic.

### Got a multidisk?
Keep it as `ONE` album folder and prefix filenames `1-01`, `1-02`, `2-01`.
Do not split into two folders.
The disc tags get set from the master later.

---

# Use gem-stash
For your very first run, one small single-disc album is the ideal guinea pig.

## 1. `pnpm scan` (optional but recommended first)

```
pnpm scan
```

- Music directory: `./work/inbox`
- Catalog: `./catalog.db`
- Confirm the scan.
- Say yes to the report; accept the default path.

This:
- walks the inbox,
- runs `ffprobe` on each file,
- classifies it (lossless-cd / lossless-hires / lossy / suspect), and
- writes a Markdown quality report under `./reports/`.

Open that report: it is your "what do I actually have" answer.
Scan is read-only, so it is completely safe to run and re-run (results are cached by absolute path).

You can skip straight to `process` (it does its own scan), but running `scan` first lets you eyeball the quality verdicts before touching anything.

## 2. `pnpm process`

```
pnpm process
```

- Work root: `./work`
- Inbox subdir: leave empty for the whole inbox, or type a subfolder name to limit the run to just that (good for testing one album).
- Catalog: `./catalog.db`
- **Verification paranoia**: a five-level ladder, themed after Crash Bandicoot masks. Default is the strongest.

  | Choice                 | Meaning                                                     |
  |------------------------|-------------------------------------------------------------|
  | None - Raw Crash       | convert only, no checks (fastest, trusts the copy)          |
  | Verify - One Mask      | `flac --verify` (proves `source PCM == FLAC` during encode) |
  | Test - Two Masks       | + `flac -t` decode self-check                               |
  | MD5 Hash - Three Masks | + end-to-end decoded-audio MD5 compare                      |
  | SHA256 - Invincibility | + the same compare with SHA-256 (default)                   |

  For a real archive run, keep the default (SHA256).
  It is the difference between "probably fine" and "mathematically proven bit-identical,"
  which is what lets you later delete the source with confidence.

- Review the plan summary (how many encodes vs copies), then confirm.

What it does per file:
- read tags
- extracts embedded art from the untouched inbox source,
- write a `<file>.sidecar.json` plus stream-copied art images next to the destination,

Then produces a tag-and-art-stripped copy under `work/archive/`:
- Lossless non-FLAC (your WAV rips) gets **encoded to FLAC** in `archive/lossless/`.
- FLAC stays FLAC, remux-copied (no re-encode) into `archive/lossless/`.
- Lossy (mp3/aac) is remux-copied into `archive/lossy/` (the re-rip queue).
- Suspect files go to `archive/suspect/` for manual review.

The inbox source is never touched.
Nothing is deleted.
A `safe-to-delete.txt` worklist is written for later.

After this, look in `work/archive/lossless/<Artist>/<Album>/`. You will see the `.flac` files, the `.sidecar.json` files, and `.artN.jpg` images.
The FLACs are currently tagless (stripped on purpose); the tags live in the sidecars.

## 3. `pnpm scaffold`

```
pnpm scaffold
```

- Catalog: `./catalog.db`
- It reports how many albums lack a master; confirm to create them.

This consolidates the per-file sidecars for each album into a single `album.sidecar.json` master in the album's folder.
Album-wide fields (album name, album artist, date, genre, compilation, totals) are lifted to an album-level block;
per-track fields (title, artist, track/disc number, front art) stay per track.
Existing masters are left alone unless you explicitly opt into a refresh.

## 4. Manual Process
Hand-edit the album master

Open the `album.sidecar.json` that scaffold wrote.
This is **the** document you edit.
Do not edit the per-file `<file>.sidecar.json` files; `tag` regenerates those from the master.

Shape (trimmed):

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

What to get right (these are the Apple Music tags that matter):

- **albumArtist**: must be identical for the whole album, which it is by construction here (it is a single album-level field).
  If you leave it empty, `tag` will prompt you for it and offer the track artists as quick picks, plus a free-text option.
  For a DJ comp, the right answer is usually the compiler / DJ, not any single track artist.
  You can fill it now or let the prompt handle it.
- **compilation**: leave it empty and let `tag` decide. It auto-sets `1` when the album has more than one distinct track artist (the DJ-comp case).
  Set it to `1` yourself only if you want to force it.
- **trackNumber / discNumber**: `number/total` form, e.g. `1/12`, `1/1`.
- **frontArt**: the filename of the cover image to embed. Point it at the right extracted `.artN.jpg`, 
  or leave it `""` to embed nothing. Apple holds one embedded front cover.
- **title / artist**: the real per-track values. For a comp the `artist` is the actual performer of that track;
  the `albumArtist` above is what groups them.

For a WAV album (no tags came in), most of these fields arrive empty, and you'll be filling them by hand from MusicBrainz or the CD sleeve.
For a rip that came in already tagged, most fields are pre-filled and you just sanity-check them.

## 5. `pnpm tag`

```
pnpm tag
```

- Work root: `./work`
- Catalog: `./catalog.db`
- If an album's albumArtist is still empty, it prompts (see above). If track artists vary, it announces it is setting `compilation = 1`.
- Review the "ready to tag" summary, then confirm.

This writes the corrected tags + front cover onto every archive file **in place**, then reads them back to confirm what actually landed:

- FLAC masters are edited with `metaflac`, which rewrites only the tag + picture blocks.
  The audio frames stay byte-identical (the STREAMINFO MD5 is unchanged). Your lossless masters are not re-encoded.
- Lossy / suspect files are tag-rewritten via `ffmpeg -c:a copy` to a temp that atomically replaces the original,
  so the audio bitstream is byte-copied, never re-encoded.

Each album gets an "Apple-ready yes/no" verdict. 
`Yes` means it passed validation and every track read back clean.
Watch the log for `readback mismatch` warnings; that is the tool telling you a tag did not land as written and is worth a look.

After this, the FLAC masters are self-describing: open one in any player,
or run `metaflac --list --block-type=VORBIS_COMMENT "<file>.flac"` to see the tags,
and `metaflac --list --block-type=PICTURE "<file>.flac"` to confirm the cover.
That is your proof the tagging worked.

## 6. `pnpm purge`
> [!Caution]
> (optional, only when you are sure)

Only run this once you trust the archive.
It reads the verified inbox sources from the catalog, shows the exact list with total size and the folder cleanup it will do, asks one explicit confirm,
then deletes the inbox sources and sweeps leftover non-media files (logs, cue sheets, cover art) into the archive folders.
This is the only step that deletes anything. For a first test, you can skip it entirely and just delete `work/` by hand later.

---

# What to do with your actual albums

## Quick rule of thumb

```
Is it lossy (mp3/aac)?            --> re-rip from disc if you have it, else it is what it is
Is it a lossless WAV/FLAC?        --> just process it; re-ripping gains nothing
Do you NOT have the disc?         --> process whatever you have; you cannot do better
Is it flagged suspect?            --> re-rip if you can, otherwise inspect by hand
```

---

# How to re-rip a CD on Mac

Use a **secure ripper with AccurateRip**.
AccurateRip cross-checks your rip against a database of known-good rips of the same disc, so you get a positive confirmation that your copy is bit-perfect (not just "no read errors").
That confidence is the whole point of re-ripping instead of dragging tracks out of the Music app.

AccurateRip is "something like `cdparanoia` for Apple".
`cdparanoia` is the secure-ripping engine (it re-reads until the reads agree and error-corrects), and on the Mac the tool that wraps a `cdparanoia`-derived engine
and adds AccurateRip on top is **XLD**.
XLD is not a GUI compromise: it is the cdparanoia-based secure ripper for macOS, the equivalent of Exact Audio Copy on Windows.
The pure-CLI options (including the real `cdparanoia`) are covered below.

## Recommended: XLD (X Lossless Decoder)

The Mac-native, no-fuss choice. Free.
Built on a cdparanoia-derived ripping engine plus AccurateRip verification, so you get secure ripping and a bit-perfect confirmation in one app.

1. Install:

   ```
   brew install --cask xld
   ```

   (or download from the XLD site if you prefer not to use Homebrew).

2. In XLD preferences:
   - Output format: **FLAC** (this pipeline's native archive format). Level 8 is fine;
     compression level does not affect the audio, only the file size.
   - Ripper mode: the secure/AccurateRip mode (XLD calls it "CDParanoia III" with AccurateRip verification).
     Leave the secure defaults on.
   - Optionally set the file-naming template to `%A/%T/%n %t` so it writes `Artist/Album/01 Title.flac`, which drops straight into the inbox layout.

3. Insert the disc. XLD looks the release up (MusicBrainz / CDDB) and fills in artist, album, and track titles.
   Fix anything wrong before ripping; those tags flow into your sidecar via `process`, so getting them right here saves editing later.

4. Rip. When it finishes, XLD reports the AccurateRip result. A confirmed result means bit-perfect.
   Keep the XLD log file next to the tracks; `purge` will sweep it into the archive folder as a leftover, so it stays with the album.

5. Move (or rip directly into) `work/inbox/<Artist>/<Album>/`, then run `pnpm process`.

## If you specifically want the CLI

Three real options, in rough order of how much they hand you:

- **cdparanoia itself.** `brew install cdparanoia` gets you the genuine article:
  the secure-ripping engine, error-corrected and re-read until the reads agree.
  What it does NOT do is AccurateRip (no cross-database bit-perfect confirmation) or metadata;
  it just gives you clean WAVs.
  Fine if you trust the disc and will tag later,
  but you lose the "provably matches a known-good rip" guarantee that is the main reason to re-rip.

- **abcde.** `brew install abcde`. A wrapper that drives cdparanoia for the rip and pulls tags from MusicBrainz,
  outputting tagged FLAC in one shot.
  Needs an `~/.abcde.conf` (FLAC output, MusicBrainz as the metadata source, a filename template).
  More setup than XLD, still no AccurateRip, but fully scriptable.

- **whipper.** The modern CLI secure ripper (the successor to morituri) and the closest CLI equivalent to EAC:
  cdparanoia engine, AccurateRip verification, and a proper rip log, with MusicBrainz metadata.
  The catch on macOS is installation: it targets Linux, and the reliable way to run it on a Mac is via Docker rather than a native `brew` or `pip` install.
  Reach for it only if you want CLI **and** AccurateRip and are comfortable with a Docker setup.

For almost everyone, XLD gives the same secure-rip-plus-AccurateRip result as whipper with none of the installation pain,
so start there and only drop to the CLI if you have a specific reason; for example, scripting a large batch, or you just prefer the terminal.

## What NOT to use for archival rips

The Apple Music / Music app can import CDs, but its default AAC import is lossy, and even its Apple Lossless import does not do AccurateRip verification.
Fine for casual use, not for building a source-of-truth archive.
Rip with XLD, then let gem-stash produce the Apple `.m4a` copies later (milestone 4) from the verified FLAC.

## Rip to FLAC or to WAV?

Rip to **FLAC**. It is lossless (bit-identical to WAV), about half the size, tags properly, and is exactly what the archive stores.
If your ripper only does WAV, that is fine too: `process` encodes WAV -> FLAC losslessly. FLAC just skips a step and carries the tags in.

---

## If something looks wrong

- **Wrong album grouping** (tracks split, or landed under `(root)`):
  the inbox folder nesting was off. Fix it to `Artist/Album/tracks` and re-run.
  The catalog caches by path, so move the files and re-process cleanly.
- **`skip-dest-exists`** in the process plan: that archive file already exists.
  `process` never overwrites the archive. Remove the old destination if you meant to redo it.
- **`readback mismatch`** after `tag`: a tag did not land as written.
  Check the specific field in the album master and the file; re-run `tag`.
- **Fresh start:** delete `catalog.db`, `reports/`, and `work/archive/`,
  and you are back to a clean slate (the inbox sources are untouched by everything except `purge`).~~~~~~~~
