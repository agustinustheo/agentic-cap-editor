import { join } from "node:path";
import {
	loadBundle,
	saveBundle,
	ensureTimeline,
	ffprobeDuration,
	recordingOffsets,
} from "./lib/cap.ts";
import { recordingSegmentPaths, type RecordingSegmentPaths } from "./lib/cursor.ts";
import { detectSilences } from "./lib/ffmpeg.ts";
import { transcribe, transcriptGaps } from "./lib/whisper.ts";
import { applyCut } from "./lib/timeline.ts";
import { parseArgs, requirePositional, num } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	noise: { type: "string", default: "-30" },
	"min-duration": { type: "string", default: "0.4" },
	padding: { type: "string", default: "0.1" },
	"intro-guard": { type: "string", default: "0.5" },
	"outro-guard": { type: "string", default: "0.5" },
	"clause-aware": { type: "boolean", default: false },
	model: { type: "string" },
	"whisper-bin": { type: "string" },
	language: { type: "string" },
	refresh: { type: "boolean", default: false },
	apply: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const noiseDb = num(values, "noise") ?? -30;
const minDurationSec = num(values, "min-duration") ?? 0.4;
const padding = num(values, "padding") ?? 0.1;
const introGuard = num(values, "intro-guard") ?? 0.5;
const outroGuard = num(values, "outro-guard") ?? 0.5;

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);

const durations: number[] = [];
for (const r of recordings) {
	durations.push(await ffprobeDuration(r.displayPath));
}
const offsets = recordingOffsets(durations);
const totalDur = durations.reduce((a, b) => a + b, 0);

async function gapsForRecording(
	rec: RecordingSegmentPaths,
): Promise<{ start: number; end: number }[]> {
	const audioSource = rec.audioPath ?? rec.displayPath;
	if (values["clause-aware"]) {
		const transcript = await transcribe({
			audioPath: audioSource,
			cacheDir: join(bundle.path, ".transcripts"),
			modelPath: typeof values.model === "string" ? values.model : undefined,
			whisperBin:
				typeof values["whisper-bin"] === "string" ? values["whisper-bin"] : undefined,
			language: typeof values.language === "string" ? values.language : undefined,
			refresh: values.refresh === true,
		});
		return transcriptGaps(transcript.segments, minDurationSec);
	}
	const raw = await detectSilences(audioSource, { noiseDb, minDurationSec });
	return raw.map((r) => ({ start: r.start, end: r.end }));
}

const source: "silence" | "transcript" = values["clause-aware"] ? "transcript" : "silence";
const proposed: { start: number; end: number }[] = [];

for (let i = 0; i < recordings.length; i++) {
	const rec = recordings[i]!;
	const offset = offsets[i]!;
	const recDuration = durations[i]!;
	const recGaps = await gapsForRecording(rec);
	for (const g of recGaps) {
		const start = g.start + padding;
		const end = g.end - padding;
		if (end <= start) continue;
		if (end - start < minDurationSec) continue;
		if (start < introGuard && i === 0) continue;
		if (end > recDuration - outroGuard && i === recordings.length - 1) continue;
		proposed.push({ start: offset + start, end: offset + end });
	}
}

proposed.sort((a, b) => a.start - b.start);

if (values.json) {
	console.log(
		JSON.stringify(
			{ source, recordings: recordings.length, totalDuration: totalDur, proposed },
			null,
			2,
		),
	);
} else if (!values.apply) {
	console.log(
		`recordings: ${recordings.length}  total duration: ${totalDur.toFixed(3)}s  detector: ${source}`,
	);
	console.log(`proposed cuts (${proposed.length}):`);
	for (const c of proposed) {
		console.log(`  ${c.start.toFixed(3)} → ${c.end.toFixed(3)}  (${(c.end - c.start).toFixed(3)}s)`);
	}
	console.log("");
	console.log("pass --apply to write these to project-config.json");
}

if (values.apply) {
	const timeline = ensureTimeline(bundle.config);
	if (timeline.segments.length === 0) {
		for (let i = 0; i < recordings.length; i++) {
			timeline.segments.push({
				recordingSegment: i,
				timescale: 1,
				start: 0,
				end: durations[i]!,
			});
		}
	}
	let cumulativeRemoved = 0;
	for (const cut of proposed) {
		const adjStart = cut.start - cumulativeRemoved;
		const adjEnd = cut.end - cumulativeRemoved;
		timeline.segments = applyCut(timeline.segments, { start: adjStart, end: adjEnd });
		cumulativeRemoved += cut.end - cut.start;
	}
	await saveBundle(bundle, { backup: !values["no-backup"] });
	const totalCut = proposed.reduce((s, c) => s + (c.end - c.start), 0);
	console.log(
		`applied ${proposed.length} cut(s) via ${source}, removed ${totalCut.toFixed(3)}s — timeline now has ${timeline.segments.length} segment(s)`,
	);
}
