---
name: cap-merge
description: Merge multiple Cap (.cap) recordings into a single snappy product video. Use when the user wants to combine N separate .cap bundles into one .cap, with transcript-aware cuts and click-driven zoom punch-ins. Triggers include "merge these recordings", "combine .cap files", "make one video out of these takes", "stitch the recordings".
---

# cap-merge

A repeatable procedure for taking N source `.cap` bundles and producing one merged, edited `.cap` bundle that is snappy, captioned, and ready to export from Cap.app.

This skill assumes the toolkit in this repo (`pnpm inspect`, `pnpm analyze:*`, `pnpm suggest:*`, `pnpm merge`, `pnpm validate`, `pnpm edit:snappy`, `pnpm bake:timeline`) is available.

## Inputs

- One or more `.cap` source bundles in `recordings/originals/`. Each is a directory containing:
  - `recording-meta.json` — schema documented in `.repos/Cap/crates/project/src/meta.rs`. The top-level fields are flattened (no `inner` wrapper). For studio recordings there is a `segments[]` array of `MultipleSegment` entries and a `cursors{}` map keyed by string IDs.
  - `content/segments/segment-N/` — per recording-segment: `display.mp4`, `camera.mp4`, `audio-input.ogg`, `cursor.json`, `keyboard.bin`.
  - `content/cursors/cursor_*.png` — cursor sprite images keyed by the IDs in `cursors{}`.
  - `project-config.json` — Cap usually creates a pristine default with one TimelineSegment per recording-segment.

## Output

A new directory `recordings/edited/<Name>.cap/` with the same shape, where:
- `segments[]` is the concatenation of all source segments in source order, renumbered 0..N-1.
- `content/segments/segment-N/` mirrors each source segment.
- `content/cursors/` contains the merged sprites with per-source-bundle ID prefixing (`b{i}_{originalId}` → `cursor_b{i}_{originalId}.png`) so IDs never collide.
- Each segment's `cursor.json` is rewritten so `cursor_id` references point to the renamed IDs.
- `cursors{}` in `recording-meta.json` is the union of all source cursor maps, keyed by the new IDs.
- `project-config.json` starts with one pristine TimelineSegment per recording-segment, then has cuts + zooms applied.

## Procedure

### 1. Orient
- Quit Cap.app before mutating anything. Cap can auto-save stale GUI state over script edits.
- `pnpm inspect <each-source.cap>` — confirm each is studio, count segments, get durations.
- If any source is an instant recording (no `segments[]`, no `display{}` — has only top-level `fps`), abort with an error: the toolkit only merges studio bundles. The user can re-record with Studio mode.

### 2. Transcribe each source
- Ensure whisper-cpp + a model are installed (`brew install whisper-cpp`, download `ggml-base.en.bin` to `~/.cache/whisper/`). If missing, install and download.
- `pnpm analyze:transcript <source.cap> --json > /tmp/transcript_<i>.json` for each source. Run all of them in the background simultaneously — transcripts take a few minutes per minute of audio with `base.en`.

### 3. Plan from transcripts
Read every transcript. Identify:
- **Take quality**: prefer longer continuous takes; drop segments that are <3s of meaningful speech, contain a stumble + restart ("uh, let me try again"), or repeat content covered by a later take.
- **Narrative order**: the natural opening, middle, closing. If multiple takes cover the same content, keep the cleanest.
- **Drops**: list segment indices to exclude from the merge, with a one-line reason each.
- **Order**: list the kept segments in narrative order.

Write the plan inline before executing it. The plan is the gate — once it's committed, the merge is mechanical.

### 4. Merge structurally
- Prefer the high-level command for first-pass edits:
  `pnpm edit:snappy <source1.cap> <source2.cap> ... --name "<Name>"`
- If you need custom segment filtering, use `pnpm merge` directly, then continue with the manual edit steps below.
- `pnpm merge <name> <source1.cap> <source2.cap> ...` builds the new bundle with all source segments included.
- Optionally pass `--include <i,j,k>` per source to filter to specific segments (recommended after step 3).
- The merge script copies content, renumbers segments, prefixes cursor IDs, rewrites each segment's `cursor.json`, and writes a default `project-config.json` with one pristine `TimelineSegment` per included recording-segment.

### 5. Apply edits
- `pnpm suggest:cuts recordings/edited/<Name>.cap --clause-aware --apply` — remove inter-clause silences for snappiness.
- `pnpm captions:add recordings/edited/<Name>.cap` — write captions against the current trimmed timeline.
- `pnpm suggest:zooms recordings/edited/<Name>.cap --apply` — punch in around click clusters.
- `pnpm inspect recordings/edited/<Name>.cap` — verify final timeline + zooms + captions.
- `pnpm validate recordings/edited/<Name>.cap --expect-edited` — mandatory final gate. It catches stale Cap overwrites, out-of-bounds captions/zooms, omitted recording segments, and helper files left beside `.cap` bundles.
- If Cap.app itself still appears raw-length, run `pnpm bake:timeline recordings/edited/<Name>.cap --out "recordings/edited/<Name> Baked.cap"` and validate the baked bundle. Cap's export/playback duration comes from `timeline.segments`, but parts of the desktop editor also expose raw media `recordingDuration`.

### 6. Hand off
Open the merged bundle in Cap.app (`pnpm render recordings/edited/<Name>.cap`) only after validation passes. Let the user preview / export, or use `--cli` once `pnpm render:build` has run.

## Decision rules

- **When in doubt about a take, keep it.** Cuts can be added later; restoring a dropped segment requires re-merge.
- **Don't cut across cursor activity.** If `pnpm analyze:clicks` shows a click within a proposed cut window, narrow the cut to leave at least 0.5s before and after the click.
- **Auto zoom mode is preferred** for click-driven punch-ins (uses cursor data Cap already has). Use `--mode manual` only if cursor data is missing or the target isn't where the cursor is.
- **Zoom JSON is lowercase.** Cap expects `mode: "auto"` or `mode: { "manual": { "x": 0.5, "y": 0.5 } }`. Uppercase `"Auto"` / `{ "Manual": ... }` will not survive the editor.
- **Caption alignment follows the current timeline.** `captions:add` skips transcript ranges and recording segments omitted by cuts/trim, so regenerate captions after any substantial timeline change.

## Failure modes and recovery

- **whisper-cli not in PATH** → `brew install whisper-cpp`; if brew unavailable, ask the user how to proceed.
- **Missing model** → download `ggml-base.en.bin` to `~/.cache/whisper/` (link in `src/lib/whisper.ts`).
- **Cursor ID collision** → the merge script must prefix by source bundle index; if it doesn't, the output cursors render with the wrong sprite. Verify by spot-checking one segment's `cursor.json` against `recording-meta.json::cursors`.
- **Timeline doesn't initialize** → `pnpm suggest:cuts --apply` will seed it if empty; if pre-existing, it should already have 1 pristine TimelineSegment per recording-segment.
- **A source bundle has zero segments** → likely an `InProgress` or `Failed` recording. Skip with a warning.
- **Cap.app overwrote edits** → quit Cap.app, rerun the edit script, then `pnpm validate --expect-edited` before opening Cap again.
- **Helper JSON in `recordings/edited/`** → move/delete it. Keep keep-range JSON in `/tmp`; top-level `recordings/edited/` should contain `.cap` bundles only.

## Implementation: src/merge.ts

If `pnpm merge` is missing from `package.json`, the merge script needs to be written before this procedure can run. Required behavior:

1. Parse CLI: `<output-name> <source1.cap> <source2.cap>...` with optional `--include <indices>` per source via `--include1`, `--include2`, etc.
2. Validate each source: studio recording, has `segments[]`, all referenced paths exist.
3. Create `recordings/edited/<output-name>.cap/` (error if it already exists unless `--force`).
4. For each source `i`:
   - For each included segment `j` (default: all):
     - Determine new segment index `newIdx`.
     - `mkdir recordings/edited/<output>.cap/content/segments/segment-<newIdx>/`
     - Copy `display.mp4`, `camera.mp4`, `audio-input.ogg`, `keyboard.bin` verbatim.
     - Read `cursor.json`, rewrite each event's `cursor_id` field from `"<oldId>"` to `"b<i>_<oldId>"`, save.
5. Copy and rename cursor sprites: `source[i]/content/cursors/cursor_<oldId>.png` → `output/content/cursors/cursor_b<i>_<oldId>.png`.
6. Build merged `cursors{}` map: union of every source's `cursors{}`, with keys renamed to `b<i>_<oldId>` and `imagePath` updated to the new sprite path.
7. Write `recording-meta.json` with `platform`, `pretty_name`, `segments`, `cursors`, `status: {status: "Complete"}`.
8. Write a pristine `project-config.json` derived from `source[0]`'s defaults (background, camera, audio, cursor settings) with `timeline: { segments: [...], zoomSegments: [] }` containing one pristine `TimelineSegment` per included recording-segment.

The Rust struct shapes are in `.repos/Cap/crates/project/src/{meta,configuration}.rs` — always read those when in doubt about field naming or required fields.
