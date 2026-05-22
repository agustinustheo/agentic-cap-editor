import { readdir, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { loadBundle } from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import {
	rawRecordingDurationLikeCap,
	recordingDurationLikeCap,
	type RecordingSegmentDuration,
} from "./lib/durations.ts";
import { timelineDuration } from "./lib/timeline.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import { isCapAppRunning } from "./lib/cap-app.ts";

const { positionals, values } = parseArgs({
	json: { type: "boolean", default: false },
	"expect-edited": { type: "boolean", default: false },
	strict: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");

interface Finding {
	level: "error" | "warning";
	code: string;
	message: string;
}

const findings: Finding[] = [];

function error(code: string, message: string): void {
	findings.push({ level: "error", code, message });
}

function warning(code: string, message: string): void {
	findings.push({ level: "warning", code, message });
}

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);
const durationDetails: RecordingSegmentDuration[] = [];
const durations: number[] = [];
for (const rec of recordings) {
	try {
		const detail = await recordingDurationLikeCap(rec);
		durationDetails.push(detail);
		durations.push(detail.duration);
	} catch (err) {
		durations.push(Number.NaN);
		error(
			"recording-duration",
			`Could not read duration for recording ${rec.recordingSegment}: ${(err as Error).message}`,
		);
	}
}

const timeline = bundle.config.timeline;
const segments = timeline?.segments ?? [];
const zooms = timeline?.zoomSegments ?? [];
const captions = timeline?.captionSegments ?? [];
const fullDuration = rawRecordingDurationLikeCap(durationDetails);
const outputDuration = timelineDuration(segments);

if (!timeline) {
	warning("timeline-missing", "project-config.json has no timeline; Cap will play raw recording state.");
}

if (segments.length === 0) {
	warning("timeline-empty", "timeline.segments is empty; verify this is intentional.");
}

for (const [i, seg] of segments.entries()) {
	const dur = durations[seg.recordingSegment];
	if (!Number.isInteger(seg.recordingSegment) || seg.recordingSegment < 0 || seg.recordingSegment >= recordings.length) {
		error("segment-recording", `timeline segment ${i} references missing recordingSegment ${seg.recordingSegment}.`);
		continue;
	}
	if (!Number.isFinite(seg.timescale) || seg.timescale <= 0) {
		error("segment-timescale", `timeline segment ${i} has invalid timescale ${seg.timescale}.`);
	}
	if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end) || seg.end <= seg.start) {
		error("segment-range", `timeline segment ${i} has invalid source range ${seg.start} -> ${seg.end}.`);
	}
	if (dur !== undefined && Number.isFinite(dur) && seg.end > dur + 0.5) {
		error(
			"segment-overrun",
			`timeline segment ${i} ends at ${seg.end.toFixed(3)}s but recording ${seg.recordingSegment} is ${dur.toFixed(3)}s.`,
		);
	}
}

for (let i = 0; i < zooms.length; i++) {
	const zoom = zooms[i]!;
	if (!Number.isFinite(zoom.start) || !Number.isFinite(zoom.end) || zoom.end <= zoom.start) {
		error("zoom-range", `zoom ${i} has invalid range ${zoom.start} -> ${zoom.end}.`);
	}
	if (
		zoom.mode !== "auto" &&
		!(
			zoom.mode &&
			typeof zoom.mode === "object" &&
			"manual" in zoom.mode &&
			Number.isFinite(zoom.mode.manual.x) &&
			Number.isFinite(zoom.mode.manual.y)
		)
	) {
		error(
			"zoom-mode",
			`zoom ${i} has invalid mode ${JSON.stringify(zoom.mode)}. Cap expects "auto" or {"manual":{"x":number,"y":number}}.`,
		);
	}
	if (zoom.start < 0 || zoom.end > outputDuration + 1e-6) {
		error(
			"zoom-bounds",
			`zoom ${i} [${zoom.start.toFixed(3)}, ${zoom.end.toFixed(3)}] is outside output duration ${outputDuration.toFixed(3)}s.`,
		);
	}
	if (i > 0 && zoom.start < zooms[i - 1]!.end) {
		error("zoom-overlap", `zoom ${i} overlaps zoom ${i - 1}.`);
	}
	if (!Number.isFinite(zoom.amount) || zoom.amount < 1) {
		error("zoom-amount", `zoom ${i} has invalid amount ${zoom.amount}.`);
	} else if (zoom.amount > 2.2) {
		warning("zoom-aggressive", `zoom ${i} uses x${zoom.amount}; check it is not too disorienting.`);
	}
}

interface CaptionLike {
	start?: unknown;
	end?: unknown;
	text?: unknown;
}

for (let i = 0; i < captions.length; i++) {
	const caption = captions[i] as CaptionLike;
	const start = Number(caption.start);
	const end = Number(caption.end);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
		error("caption-range", `caption ${i} has invalid range ${String(caption.start)} -> ${String(caption.end)}.`);
	}
	if (start < 0 || end > outputDuration + 1e-6) {
		error(
			"caption-bounds",
			`caption ${i} [${start.toFixed(3)}, ${end.toFixed(3)}] is outside output duration ${outputDuration.toFixed(3)}s.`,
		);
	}
	if (i > 0) {
		const prev = captions[i - 1] as CaptionLike;
		const prevStart = Number(prev.start);
		if (Number.isFinite(prevStart) && start < prevStart) {
			error("caption-order", `caption ${i} starts before caption ${i - 1}.`);
		}
	}
	if (typeof caption.text !== "string" || caption.text.trim().length === 0) {
		warning("caption-empty", `caption ${i} has empty text.`);
	}
}

const usedRecordings = new Set(segments.map((s) => s.recordingSegment));
const unusedRecordings = recordings
	.map((r) => r.recordingSegment)
	.filter((idx) => !usedRecordings.has(idx));
if (unusedRecordings.length > 0) {
	warning(
		"unused-recordings",
		`recordingSegment(s) omitted from timeline: ${unusedRecordings.join(", ")}. This is fine for bad takes, but verify it was intentional.`,
	);
}

if (values["expect-edited"]) {
	const hasSpeedRamp = segments.some((s) => Math.abs(s.timescale - 1) > 1e-6);
	const isTrimmed = fullDuration > 0 && outputDuration < fullDuration - 1;
	const hasMotionOrTimelineEdit = isTrimmed || zooms.length > 0 || hasSpeedRamp;
	if (!hasMotionOrTimelineEdit) {
		error(
			"unedited",
			"expected an edited project, but timeline duration matches source and there are no zooms or speed/timeline changes. Captions alone are not enough for an edited video.",
		);
	}
	const rawDurationGap = Math.abs(fullDuration - outputDuration);
	const rawDurationGapIsVisiblyDifferent = rawDurationGap > Math.max(5, outputDuration * 0.02);
	if (isTrimmed && rawDurationGapIsVisiblyDifferent) {
		warning(
			"cap-editor-raw-duration",
			`Cap.app's editorInstance.recordingDuration is still raw media length ${fullDuration.toFixed(3)}s; export/playback timeline duration is ${outputDuration.toFixed(3)}s. If the Cap UI itself must not look raw-length, run pnpm bake:timeline to create a baked .cap copy.`,
		);
	}
}

if (basename(dirname(capPath)) === "edited") {
	const siblings = await readdir(dirname(capPath), { withFileTypes: true });
	const stray = [];
	for (const entry of siblings) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && entry.name.endsWith(".cap")) continue;
		const entryPath = `${dirname(capPath)}/${entry.name}`;
		const entryStat = await stat(entryPath).catch(() => null);
		if (entryStat?.isFile() || entryStat?.isDirectory()) stray.push(entry.name);
	}
	if (stray.length > 0) {
		warning(
			"edited-stray-files",
			`recordings/edited contains non-.cap artifact(s): ${stray.join(", ")}. Keep helper files in /tmp or inside scripts, not beside projects.`,
		);
	}
}

if (await isCapAppRunning()) {
	warning(
		"cap-running",
		"Cap.app is running. Do not mutate project-config.json until Cap is quit, or it may overwrite edits with stale state.",
	);
}

const summary = {
	path: capPath,
	recordings: recordings.length,
	rawMediaDurationSec: Number(fullDuration.toFixed(3)),
	outputDurationSec: Number(outputDuration.toFixed(3)),
	timelineSegments: segments.length,
	zoomSegments: zooms.length,
	captionSegments: captions.length,
	recordingDurations: durationDetails,
	unusedRecordings,
	findings,
	ok:
		findings.every((f) => f.level !== "error") &&
		(values.strict ? findings.every((f) => f.level !== "warning") : true),
};

if (values.json) {
	console.log(JSON.stringify(summary, null, 2));
} else {
	console.log(`# ${capPath}`);
	console.log(`recordings:      ${summary.recordings}`);
	console.log(`raw media dur:   ${summary.rawMediaDurationSec.toFixed(3)}s`);
	console.log(`output duration: ${summary.outputDurationSec.toFixed(3)}s`);
	console.log(`timeline:        ${summary.timelineSegments} segment(s)`);
	console.log(`zooms:           ${summary.zoomSegments}`);
	console.log(`captions:        ${summary.captionSegments}`);
	console.log("");
	if (findings.length === 0) {
		console.log("validation: ok");
	} else {
		console.log("findings:");
		for (const f of findings) {
			console.log(`  ${f.level.toUpperCase()} ${f.code}: ${f.message}`);
		}
	}
}

if (!summary.ok) process.exit(1);
