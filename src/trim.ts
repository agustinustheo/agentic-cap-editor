import { readFile } from "node:fs/promises";
import {
	loadBundle,
	saveBundle,
	ensureTimeline,
	ffprobeDuration,
} from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

interface KeepRange {
	recordingSegment: number;
	start: number;
	end: number;
	timescale?: number;
}

const { positionals, values } = parseArgs({
	keep: { type: "string" },
	"from-json": { type: "string" },
	"clear-zooms": { type: "boolean", default: true },
	"clear-captions": { type: "boolean", default: true },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");

function parseKeepString(spec: string): KeepRange[] {
	const out: KeepRange[] = [];
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const m = trimmed.match(/^(\d+):(-?[0-9.]+)-(-?[0-9.]+)(?:@x([0-9.]+))?$/);
		if (!m) {
			console.error(`error: bad --keep token "${trimmed}" — expected "rec:start-end" or "rec:start-end@xSPEED"`);
			process.exit(2);
		}
		const rec = Number(m[1]);
		const start = Number(m[2]);
		const end = Number(m[3]);
		const timescale = m[4] ? Number(m[4]) : 1;
		if (end <= start) {
			console.error(`error: keep range ${trimmed} has end <= start`);
			process.exit(2);
		}
		out.push({ recordingSegment: rec, start, end, timescale });
	}
	return out;
}

let keeps: KeepRange[] = [];
if (typeof values.keep === "string") {
	keeps = parseKeepString(values.keep);
}
if (typeof values["from-json"] === "string") {
	const data = JSON.parse(await readFile(values["from-json"], "utf8")) as KeepRange[];
	keeps = keeps.concat(data);
}
if (keeps.length === 0) {
	console.error("error: provide --keep or --from-json (no ranges given)");
	process.exit(2);
}

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);

const recDurations: number[] = [];
for (const r of recordings) {
	recDurations.push(await ffprobeDuration(r.displayPath));
}

for (const k of keeps) {
	if (k.recordingSegment < 0 || k.recordingSegment >= recordings.length) {
		console.error(
			`error: keep range references recording ${k.recordingSegment}, bundle has ${recordings.length}`,
		);
		process.exit(1);
	}
	const dur = recDurations[k.recordingSegment]!;
	if (k.end > dur + 0.5) {
		console.error(
			`warning: keep ${k.recordingSegment}:${k.start}-${k.end} exceeds recording duration ${dur.toFixed(3)}s — clamping`,
		);
		k.end = dur;
	}
}

interface TimelineSegmentOut {
	recordingSegment: number;
	timescale: number;
	start: number;
	end: number;
}

const newSegments: TimelineSegmentOut[] = keeps.map((k) => ({
	recordingSegment: k.recordingSegment,
	timescale: k.timescale ?? 1,
	start: k.start,
	end: k.end,
}));

const totalDur = newSegments.reduce((s, t) => s + (t.end - t.start) / t.timescale, 0);

if (values["dry-run"]) {
	console.log(JSON.stringify({ segments: newSegments, totalDuration: totalDur }, null, 2));
	console.log(`(dry-run: not saved)`);
	process.exit(0);
}

const timeline = ensureTimeline(bundle.config);
timeline.segments = newSegments;
if (values["clear-zooms"]) timeline.zoomSegments = [];
if (values["clear-captions"]) timeline.captionSegments = [];

await saveBundle(bundle, { backup: !values["no-backup"] });
console.log(
	`wrote ${newSegments.length} timeline segment(s), total duration ${totalDur.toFixed(3)}s`,
);
console.log(`  clear-zooms: ${values["clear-zooms"]}, clear-captions: ${values["clear-captions"]}`);
