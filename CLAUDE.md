# CLAUDE.md

Workflow for using this repo to edit Cap (`.cap`) recordings.

## What this repo is

A small TypeScript toolkit that edits Cap recording bundles **non-destructively** by mutating `project-config.json` inside a `.cap` directory. The Cap desktop editor reads the same file, so any edits you make show up immediately in the GUI and at export time. Raw video (`content/*.mp4`) is never touched.

Upstream Cap source lives in `.repos/Cap` (git submodule). The authoritative shapes for the JSON we manipulate are:
- `.repos/Cap/crates/project/src/configuration.rs` — `ProjectConfiguration`, `TimelineConfiguration`, `TimelineSegment`, `ZoomSegment`, etc. (serde `rename_all = "camelCase"`)
- `.repos/Cap/crates/project/src/meta.rs` — `RecordingMeta`, `StudioRecordingMeta`, `InstantRecordingMeta`

When in doubt about a field name or shape, read the Rust source. It is the source of truth, not the TS types in `src/lib/cap.ts` (which are intentionally partial: we only type fields we manipulate, and pass through the rest).

## Anatomy of a `.cap` bundle

```
MyRecording.cap/                  # directory bundle
├── recording-meta.json           # what was captured; READ-only from this toolkit
├── project-config.json           # all edits live here; this is what we mutate
└── content/
    ├── output.mp4                # instant recordings
    ├── display.mp4               # studio (single segment)
    ├── camera.mp4
    ├── audio-input.mp3
    ├── segments/segment-N/...    # studio (multiple segments)
    └── cursors/cursor_*.png
```

Edits in `project-config.json` are arrays of typed segments. The two most important are:
- `timeline.segments[]` — playback ranges (`TimelineSegment { recordingSegment, timescale, start, end }`). Cuts are expressed as splits/removals of these.
- `timeline.zoomSegments[]` — mouse close-ups (`ZoomSegment { start, end, amount, mode, ... }`).

Other arrays present in the schema but not yet wrapped by this toolkit: `sceneSegments`, `maskSegments`, `textSegments`, `captionSegments`, `keyboardSegments`, `annotations`.

## Commands

All scripts take the `.cap` path as the first positional arg. Mutating scripts save a timestamped `project-config.json.<ts>.bak` unless `--no-backup` is passed.

### Read / analyze (no mutation)

```bash
# Always start here — prints timeline, zoom segments, and durations.
pnpm inspect path/to/Recording.cap
pnpm inspect path/to/Recording.cap --json

# Verify the project is internally consistent before saying "done".
pnpm validate path/to/Recording.cap
pnpm validate path/to/Recording.cap --expect-edited

# Detect silent regions for cut candidates.
pnpm analyze:silences path/to/Recording.cap --noise=-30 --min-duration 0.4
pnpm analyze:silences path/to/Recording.cap --json

# Summarize cursor data (move/click counts per recording segment).
pnpm analyze:cursor path/to/Recording.cap

# List every click-down event with cursor position at that moment.
pnpm analyze:clicks path/to/Recording.cap --json

# Transcribe with whisper.cpp (cached under <cap>/.transcripts/).
pnpm analyze:transcript path/to/Recording.cap
pnpm analyze:transcript path/to/Recording.cap --refresh --json

# Extract a single frame at time T as a PNG so you can SEE the video.
# Open the resulting PNG with the Read tool — Claude is multimodal.
pnpm frame path/to/Recording.cap --at 12.5
pnpm frame path/to/Recording.cap --at 12.5 --out /tmp/check.png
```

### Suggest (proposes edits; `--apply` writes them)

```bash
# Snappy: cut every silence longer than --min-duration, with padding.
pnpm suggest:cuts path/to/Recording.cap
pnpm suggest:cuts path/to/Recording.cap --apply

# Clause-aware (uses whisper transcript instead of raw silencedetect — tighter,
# avoids cutting through breath/word tails).
pnpm suggest:cuts path/to/Recording.cap --clause-aware
pnpm suggest:cuts path/to/Recording.cap --clause-aware --apply

# Mouse close-ups: zoom around each click cluster.
pnpm suggest:zooms path/to/Recording.cap
pnpm suggest:zooms path/to/Recording.cap --amount 1.8 --apply
pnpm suggest:zooms path/to/Recording.cap --mode manual --apply   # use cursor x/y

# Burn the transcript in as Cap captions (writes captions.json + timeline.captionSegments).
# Safe before or after cuts; omitted ranges and omitted recording segments are skipped.
pnpm captions:add path/to/Recording.cap
pnpm captions:add path/to/Recording.cap --dry-run
```

### Render (export to mp4)

```bash
# Default on macOS: opens the .cap in Cap.app (use the Export button there).
pnpm render path/to/Recording.cap

# Headless CLI export — requires one-time build of Cap's export pipeline.
pnpm render:build                                       # ~5–10 min, one-time
pnpm render path/to/Recording.cap --cli                 # uses defaults: 60fps 1920x1080 Web
pnpm render path/to/Recording.cap --cli --fps 30 --compression Maximum
# Output lands at <cap>/output/result.mp4
```

`--cli` requires the export-cli built; if missing, the script prints the build command. CLI export only works for **studio** recordings — instant recordings already have a usable mp4 at `content/output.mp4` and `render` reports the path without re-encoding.

### Mutate (write project-config.json directly)

```bash
pnpm zoom:add path/to/Recording.cap --start 5.0 --end 8.0 --amount 1.5
pnpm zoom:add path/to/Recording.cap --start 5.0 --end 8.0 --amount 1.8 --x 0.5 --y 0.5
pnpm zoom:add path/to/Recording.cap --start 5.0 --end 8.0 --amount 1.5 --dry-run

pnpm zoom:list path/to/Recording.cap
pnpm zoom:remove path/to/Recording.cap 2

pnpm cut path/to/Recording.cap --start 5.0 --end 8.0
pnpm cut path/to/Recording.cap --start 5.0 --end 8.0 --dry-run

# Replace the timeline with explicit keep ranges. Keep helper JSON in /tmp,
# never beside .cap bundles in recordings/edited/.
pnpm trim path/to/Recording.cap --from-json /tmp/keep-ranges.json

# One-command first pass for future agents. Creates/merges under recordings/edited,
# closes Cap.app, applies cuts/captions/zooms, then validates.
pnpm edit:snappy path/to/Recording.cap --name "Recording Commercial"
pnpm edit:snappy path/to/A.cap path/to/B.cap --name "Merged Commercial"
```

`pnpm typecheck` runs `tsc --noEmit` across `src/`. Run this before declaring a task complete.

## Working directory: `recordings/`

`recordings/` is gitignored (except its README + .gitkeep). Drop `.cap` bundles here. Convention:

```
recordings/
├── originals/    # untouched source bundles
└── edited/       # working copies — run scripts against these
```

Always copy first so the original stays pristine: `cp -R recordings/originals/Demo.cap recordings/edited/Demo.cap`. Then run scripts against the copy. If anything goes wrong, mutating scripts also write `project-config.json.<timestamp>.bak` inside the bundle.

## End-to-end "make it snappy" recipe

Fast path:

1. `pnpm edit:snappy recordings/originals/Demo.cap --name "Demo Commercial"` — copy into `recordings/edited/`, tighten, caption, zoom, and validate.
2. `pnpm validate "recordings/edited/Demo Commercial.cap" --expect-edited` — rerun after any manual tweak.
3. `pnpm render "recordings/edited/Demo Commercial.cap" --via-app` — open in Cap.app only after validation.

Manual path:

1. `cp -R recordings/originals/Demo.cap recordings/edited/Demo.cap` — work on a copy.
2. `pnpm inspect recordings/edited/Demo.cap` — confirm duration, timeline state.
3. `pnpm analyze:transcript recordings/edited/Demo.cap` — generate transcript (cached).
4. `pnpm suggest:cuts recordings/edited/Demo.cap --clause-aware` — review proposed cuts.
5. `pnpm suggest:cuts recordings/edited/Demo.cap --clause-aware --apply` — tighten.
6. `pnpm captions:add recordings/edited/Demo.cap` — add captions mapped to the current timeline.
7. `pnpm analyze:clicks recordings/edited/Demo.cap` — confirm where the action is.
8. `pnpm suggest:zooms recordings/edited/Demo.cap` — review zoom plan.
9. `pnpm suggest:zooms recordings/edited/Demo.cap --apply` — punch in on each click cluster.
10. `pnpm inspect recordings/edited/Demo.cap` — verify final timeline + zoom layout.
11. `pnpm validate recordings/edited/Demo.cap --expect-edited` — catch stale Cap overwrites, bad bounds, caption leaks, and stray helper files.
12. `pnpm render recordings/edited/Demo.cap` — opens in Cap.app to preview/export, or pass `--cli` once `render:build` has run.

If any individual proposal looks wrong, sample a keyframe with `pnpm frame <cap> --at T --out /tmp/check.png` and Read the PNG to decide what to do manually.

## Multi-segment studio recordings

Cap can record multiple clips and stitch them into one project (`MultipleSegments` in `recording-meta.json`). The toolkit supports these:

- `analyze:silences`, `analyze:cursor`, `analyze:clicks`, `analyze:transcript` run per recording segment and report per-segment results.
- `suggest:cuts` and `captions:add` initialize the timeline (when empty) with one `TimelineSegment` per recording in order, then map silences/transcript from recording-time into the concatenated output time before applying. So the first recipe step above works as-is for multi-segment.
- `captions:add` writes captions against the current timeline. If a recording segment has been intentionally omitted from the timeline, its transcript is dropped instead of leaking into output time zero.
- `validate --expect-edited` is mandatory before final handoff. It catches exactly the failure modes agents miss: Cap.app overwriting the project back to raw duration, zoom/caption ranges past the end, omitted recording segments, and helper files accidentally left in `recordings/edited/`.

## Critical: close Cap.app before mutating

Cap.app appears to auto-save its in-memory project state when the bundle is open. If you run any mutating script (`suggest:cuts --apply`, `suggest:zooms --apply`, `captions:add`, `zoom:add`, `zoom:remove`, `cut`, `trim`, `merge`) while Cap.app has the same bundle open, **Cap.app may overwrite your edits with its stale state when the user scrubs the timeline or clicks anything**. Always `Cmd+Q` Cap.app first, run the scripts, then `open <cap>` to preview.

## External deps

- `ffmpeg` + `ffprobe` in PATH. Install: `brew install ffmpeg`.
- `whisper-cli` for transcripts. Install: `brew install whisper-cpp`.
- A whisper model file. One-time setup:
  ```bash
  mkdir -p ~/.cache/whisper && \
    curl -L -o ~/.cache/whisper/ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
  Or pass `--model /path/to/ggml-*.bin` / set `WHISPER_MODEL` env var. `base.en` is the speed/quality sweet spot; use `small.en` or `medium.en` for higher accuracy.
- Node 20+. Cap requires it too, so already on the box.

## Conventions for AI edits

1. **Always `pnpm inspect` first.** You need the source duration and current segment layout before adding zooms or cuts. The output is designed to be parseable.
2. **Times are in seconds, float.** Output (timeline) time, not source time — Cap renders at output time.
3. **Zoom `amount`:** 1.0 = no zoom, 1.5–1.8 is a comfortable mouse close-up, 2.0+ is aggressive.
4. **Zoom `mode`:**
   - `Auto` (no `--x/--y`): Cap targets the cursor at zoom start. Prefer this for mouse close-ups.
   - `Manual { x, y }`: normalized 0..1 coords. Use for highlighting non-cursor regions.
5. **Don't overlap zoom segments.** `zoom:add` refuses overlaps; remove the existing segment first if intentional.
6. **Cuts are non-destructive splits.** A cut on a single-segment timeline becomes two segments around the gap. Re-cutting the same range is a no-op (idempotent for fully-covered ranges).
7. **Backups exist.** `project-config.json.<timestamp>.bak` is written on each save. To roll back, copy the `.bak` back.
8. **Don't touch `recording-meta.json` or `content/`.** Those are recording artifacts. Only `project-config.json` is editable.
9. **Always `pnpm validate --expect-edited` before final.** If validation warns about omitted segments or Cap.app running, say so explicitly or fix it.
10. **No helper files in `recordings/edited/`.** Use `/tmp/*.json` for keep ranges and screenshots. The user expects only `.cap` bundles at the top level.

## When to extend the toolkit

If the user asks for an edit type not yet covered (text overlays, masks, annotations, scene segments, captions, speed ramps), add a new script under `src/`:
- Read the Rust struct in `.repos/Cap/crates/project/src/configuration.rs` to get the exact field names and shapes (remember `rename_all = "camelCase"`).
- Mirror only the fields you mutate in `src/lib/cap.ts`. Pass the rest through opaquely.
- Add a `pnpm <name>` script in `package.json`.
- Use `parseArgs` from `src/lib/cli.ts`.
- Save via `saveBundle()` so backups happen automatically.

## What to never do

- Don't edit `.repos/Cap/**` — it's an upstream submodule.
- Don't re-encode video to mp4 as part of an edit. All edits are JSON. Re-encoding loses cursor metadata and quality.
- Don't add comments to scripts explaining what the code does. Keep code self-documenting; this file is the workflow doc.
- Don't widen the partial types in `src/lib/cap.ts` to "full" mirrors of Cap's structs unless you also generate them from `specta`. Drift is a bigger risk than missing fields.
