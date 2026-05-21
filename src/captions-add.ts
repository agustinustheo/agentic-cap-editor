import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	loadBundle,
	saveBundle,
	ensureTimeline,
	ffprobeDuration,
	recordingOffsets,
} from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { transcribe, type TranscriptSegment } from "./lib/whisper.ts";
import { parseArgs, requirePositional, num } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	model: { type: "string" },
	"whisper-bin": { type: "string" },
	language: { type: "string" },
	refresh: { type: "boolean", default: false },
	"min-gap": { type: "string", default: "0.25" },
	"max-chars": { type: "string", default: "80" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const minGap = num(values, "min-gap") ?? 0.25;
const maxChars = num(values, "max-chars") ?? 80;

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);

if (bundle.config.timeline?.segments && bundle.config.timeline.segments.length > 0) {
	const segs = bundle.config.timeline.segments;
	const pristine =
		segs.length === recordings.length &&
		segs.every(
			(s, i) =>
				s.timescale === 1 &&
				s.start === 0 &&
				s.recordingSegment === i,
		);
	if (!pristine) {
		console.error(
			"warning: timeline has cuts/edits applied — captions will be in pristine recording-concat time and may not align. Add captions BEFORE cutting, or be prepared to fix alignment in Cap.app.",
		);
	}
}

const cacheDir = join(bundle.path, ".transcripts");
const durations: number[] = [];
for (const r of recordings) {
	durations.push(await ffprobeDuration(r.displayPath));
}
const offsets = recordingOffsets(durations);

const allSegments: TranscriptSegment[] = [];
for (let i = 0; i < recordings.length; i++) {
	const rec = recordings[i]!;
	const offset = offsets[i]!;
	const audioSource = rec.audioPath ?? rec.displayPath;
	const transcript = await transcribe({
		audioPath: audioSource,
		cacheDir,
		modelPath: typeof values.model === "string" ? values.model : undefined,
		whisperBin: typeof values["whisper-bin"] === "string" ? values["whisper-bin"] : undefined,
		language: typeof values.language === "string" ? values.language : undefined,
		refresh: values.refresh === true,
	});
	for (const s of transcript.segments) {
		allSegments.push({
			startSec: s.startSec + offset,
			endSec: s.endSec + offset,
			text: s.text,
		});
	}
}
allSegments.sort((a, b) => a.startSec - b.startSec);

interface CaptionSegment {
	id: string;
	start: number;
	end: number;
	text: string;
	words: never[];
}

const merged: CaptionSegment[] = [];
for (const seg of allSegments) {
	const last = merged[merged.length - 1];
	if (
		last &&
		seg.startSec - last.end < minGap &&
		last.text.length + seg.text.length + 1 <= maxChars
	) {
		last.end = seg.endSec;
		last.text = `${last.text} ${seg.text}`.trim();
		continue;
	}
	merged.push({
		id: randomUUID(),
		start: seg.startSec,
		end: seg.endSec,
		text: seg.text,
		words: [],
	});
}

const captionsData = {
	segments: merged,
	settings: {
		enabled: true,
		font: "System Sans-Serif",
		size: 24,
		color: "#FFFFFF",
		backgroundColor: "#000000",
		backgroundOpacity: 90,
		position: "bottom-center",
		italic: false,
		fontWeight: 700,
		outline: false,
		outlineColor: "#000000",
		exportWithSubtitles: false,
		highlightColor: "#FFFFFF",
		fadeDuration: 0.15,
		lingerDuration: 0.4,
		wordTransitionDuration: 0.25,
		activeWordHighlight: false,
	},
};

if (values["dry-run"]) {
	console.log(JSON.stringify(captionsData, null, 2));
	console.log(`(dry-run: ${merged.length} caption segment(s) across ${recordings.length} recording(s), not saved)`);
} else {
	const captionsPath = join(bundle.path, "captions.json");
	await writeFile(captionsPath, `${JSON.stringify(captionsData, null, 2)}\n`);
	const timeline = ensureTimeline(bundle.config);
	timeline.captionSegments = merged;
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(
		`wrote ${merged.length} caption segment(s) (${recordings.length} recording(s)) to ${captionsPath} and timeline.captionSegments`,
	);
}
