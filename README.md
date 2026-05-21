# agentic-cap-editor

A TypeScript toolkit + agent workflow for editing [Cap](https://cap.so) screen recordings non-destructively from the CLI. Operates directly on `.cap` bundles by mutating `project-config.json` — Cap's own editor reads the same file, so any edit is immediately visible in Cap.app at export time.

The toolkit is designed so an AI agent can read a recording, decide where to cut and where to zoom, and apply those edits as JSON — without ever re-encoding video or watching frames in sequence.

## Why this exists

Editing a screen recording into a "snappy" product video is mostly mechanical: cut every long silence, punch in on every meaningful click, fix the takes you stumbled on. All of that can be expressed as JSON edits on top of immutable source media — which is exactly how Cap stores its project state.

Instead of dragging clips around in a GUI, you point this toolkit at a `.cap` bundle and:

1. **Read** — `inspect`, `analyze:silences`, `analyze:clicks`, `analyze:transcript`, `frame`
2. **Plan** — `suggest:cuts`, `suggest:zooms` (dry-run by default)
3. **Apply** — `--apply` flips them to write edits into `project-config.json`
4. **Render** — open in Cap.app, or use the headless `pnpm render --cli` path

## Quick start

```bash
# 1. Install deps
pnpm install
brew install ffmpeg whisper-cpp
mkdir -p ~/.cache/whisper && \
  curl -L -o ~/.cache/whisper/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# 2. Drop a .cap bundle in recordings/originals/ (Cap stores them at
#    ~/Library/Application Support/so.cap.desktop/recordings/).
cp -R ~/Library/Application\ Support/so.cap.desktop/recordings/Demo.cap recordings/originals/

# 3. Let the agent-safe pipeline create the edited project.
pnpm edit:snappy "recordings/originals/Demo.cap" --name "Demo Commercial"
pnpm validate "recordings/edited/Demo Commercial.cap" --expect-edited
pnpm render "recordings/edited/Demo Commercial.cap" --via-app
```

## Commands

All take a `.cap` path as the first positional arg. Mutating commands write a timestamped `project-config.json.<ts>.bak` next to the live config; `--no-backup` disables.

### Read / analyze (no mutation)

| Command | Purpose |
|---|---|
| `pnpm inspect <cap>` | Timeline, zoom, caption summary + source duration |
| `pnpm analyze:silences <cap>` | ffmpeg silencedetect → cuttable ranges |
| `pnpm analyze:cursor <cap>` | Cursor move/click counts per recording segment |
| `pnpm analyze:clicks <cap>` | Every click-down with cursor position |
| `pnpm analyze:transcript <cap>` | whisper.cpp transcript, cached to `<cap>/.transcripts/` |
| `pnpm frame <cap> --at T` | Extract a single PNG so an agent can inspect the frame visually |
| `pnpm validate <cap>` | Verify timeline, zooms, captions, omitted segments, and edited-folder hygiene |

### Suggest (dry-run by default, `--apply` to commit)

| Command | Purpose |
|---|---|
| `pnpm suggest:cuts <cap>` | Cut silent ranges (use `--clause-aware` for transcript-snapped cuts) |
| `pnpm suggest:zooms <cap>` | Punch-in around click clusters (`--mode manual` uses cursor x/y) |

### Mutate

| Command | Purpose |
|---|---|
| `pnpm zoom:add <cap>` | Add a single zoom (`--start --end --amount [--x --y]`) |
| `pnpm zoom:list <cap>` | List current zooms |
| `pnpm zoom:remove <cap> <idx>` | Remove a zoom by index |
| `pnpm cut <cap>` | Cut a single range from the timeline |
| `pnpm captions:add <cap>` | Write transcript as Cap captions |
| `pnpm merge <name> <cap1> [<cap2> ...]` | Merge N source bundles into one (with optional `--include` filters per source) |
| `pnpm trim <cap>` | Replace timeline with explicit keep ranges |
| `pnpm edit:snappy <cap...>` | High-level first pass: copy/merge, cut, caption, zoom, validate |

### Render

| Command | Purpose |
|---|---|
| `pnpm render <cap>` | macOS default: `open <cap>` in Cap.app. With `--cli`, runs the headless export. |
| `pnpm render:build` | One-time `cargo build --release --example export-cli` against `.repos/Cap` |

## Directory layout

```
.
├── src/                    # the toolkit (TypeScript, run via tsx — no build step)
│   ├── lib/                # cap.ts, cursor.ts, ffmpeg.ts, whisper.ts, timeline.ts, cli.ts
│   ├── inspect.ts          # one script per pnpm command
│   ├── analyze-*.ts
│   ├── suggest-*.ts
│   ├── zoom-*.ts
│   ├── captions-add.ts
│   ├── merge.ts
│   ├── cut.ts
│   ├── frame.ts
│   └── render.ts
├── .codex/skills/
│   └── cap-merge/
│       └── SKILL.md        # procedure for merging N .cap recordings into one snappy video
├── .claude -> .codex       # Claude compatibility symlink
├── .repos/Cap/             # upstream Cap source as a git submodule — authoritative schema
├── recordings/             # gitignored working directory
│   ├── originals/          # untouched source bundles
│   └── edited/             # working copies — all edits land here
├── AGENTS.md               # workflow rules for agents in this repo
├── CLAUDE.md -> AGENTS.md  # Claude compatibility symlink
├── LICENSE                 # MIT
├── package.json
└── tsconfig.json
```

## How `.cap` editing works

A `.cap` file is a directory bundle:

```
Demo.cap/
├── recording-meta.json     # what was recorded (segments, sources, paths, cursor map)
├── project-config.json     # all edits — cuts, zooms, captions, background, ...
└── content/
    ├── segments/segment-N/
    │   ├── display.mp4         # raw screen capture
    │   ├── camera.mp4
    │   ├── audio-input.ogg
    │   ├── cursor.json
    │   └── keyboard.bin
    └── cursors/cursor_*.png    # cursor sprites keyed by id
```

The raw recordings are **never modified**. All edits live as JSON in `project-config.json` and get applied at render time by Cap's `rendering` + `editor` crates. The schema is in `.repos/Cap/crates/project/src/{configuration,meta}.rs` — that's the source of truth, not the TS types in `src/lib/cap.ts` (which are intentionally partial: types only the fields we mutate, pass everything else through).

The two most-edited arrays:

- `timeline.segments[]` — playback ranges (`{ recordingSegment, timescale, start, end }`). Cuts are expressed as splits/removals.
- `timeline.zoomSegments[]` — mouse close-ups (`{ start, end, amount, mode: "Auto" | { Manual: { x, y } } }`).

## End-to-end "make it snappy" recipe

1. Drop your `.cap` in `recordings/originals/`.
2. `cp -R recordings/originals/Demo.cap recordings/edited/Demo.cap` — work on a copy.
3. `pnpm inspect recordings/edited/Demo.cap` — confirm duration, timeline state.
4. `pnpm analyze:transcript recordings/edited/Demo.cap` — generate transcript (cached).
5. `pnpm suggest:cuts recordings/edited/Demo.cap --clause-aware --apply` — tighten.
6. `pnpm captions:add recordings/edited/Demo.cap` — add captions after trimming; omitted ranges are skipped.
7. `pnpm suggest:zooms recordings/edited/Demo.cap --apply` — punch in on click clusters.
8. `pnpm validate recordings/edited/Demo.cap --expect-edited` — verify final timeline, zooms, captions, and no stray helper files.
9. `pnpm render recordings/edited/Demo.cap` — open in Cap.app to preview / export.

To merge multiple takes into one bundle first, use `pnpm merge`. See `.codex/skills/cap-merge/SKILL.md` for the full procedure.

## How the AI part works

An agent doesn't watch the video frame-by-frame. It uses four data streams extracted from the `.cap`:

1. **Cursor track** — already in the bundle as `cursor.json`. Tells the agent exactly where clicks happen and where to put zooms.
2. **Audio silence** — ffmpeg `silencedetect` returns `(start, end)` of every quiet gap.
3. **Transcript** — whisper.cpp produces `(start, end, text)` segments. Lets the agent snap cuts to clause boundaries instead of mid-word.
4. **Keyframes on demand** — when the agent is uncertain, it runs `pnpm frame <cap> --at 12.5 --out /tmp/check.png` and opens the PNG with an image viewer or multimodal read tool.

`AGENTS.md` at the repo root teaches agents the workflow rules, with `CLAUDE.md` kept as a compatibility symlink. `.codex/skills/cap-merge/SKILL.md` adds a discoverable skill for merging multiple recordings, with `.claude` kept as a compatibility symlink.

## Dependencies

- **Node 20+** with `pnpm` — required by both Cap and this toolkit
- **ffmpeg + ffprobe** in PATH — `brew install ffmpeg`
- **whisper-cpp** for transcripts — `brew install whisper-cpp`, plus a GGML model at `~/.cache/whisper/ggml-base.en.bin` (`base.en` is the speed/quality sweet spot; `small.en` or `medium.en` for higher accuracy). Override with `WHISPER_MODEL` env var or `--model` arg.
- **Rust toolchain** — only required if you want headless `pnpm render --cli`. Cap.app on macOS handles export with no extra setup.

## Limits / known caveats

- **Cap.app can overwrite script edits.** Quit Cap before every mutation. `edit:snappy` closes it automatically, and `validate` warns if it is running.
- **`render:build` compiles a large chunk of Cap.** Cap's `cap-export` crate pulls in `cap-rendering`, `cap-editor`, `cap-media`, etc. First build is 5–10 minutes and needs system FFmpeg dev libs.
- **`merge` cursor namespacing** prefixes IDs with `b<sourceIndex>_`. Sprites are copied and renamed under `content/cursors/`. Each segment's `cursor.json` is rewritten to use the new IDs so cross-bundle ID collisions can't render the wrong sprite.
- **Partial TS types**. `src/lib/cap.ts` only types the fields we mutate. Always cross-check against `.repos/Cap/crates/project/src/{configuration,meta}.rs` when wiring up a new edit kind — that's the source of truth, and `serde` rename rules differ by struct.

## License

MIT — see [LICENSE](./LICENSE). Cap itself (vendored under `.repos/Cap`) is AGPLv3 with MIT carve-outs; this toolkit only reads its source for schema reference and never links to or redistributes Cap code.
