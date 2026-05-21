import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadBundle, saveBundle, ensureTimeline } from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { transcribe } from "./lib/whisper.ts";
import { refineCaptions } from "./lib/captions-refine.ts";
import { parseArgs, requirePositional, num } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	model: { type: "string" },
	"whisper-bin": { type: "string" },
	language: { type: "string" },
	refresh: { type: "boolean", default: false },
	"max-chars": { type: "string", default: "60" },
	"max-dur": { type: "string", default: "5.0" },
	"paragraph-gap": { type: "string", default: "0.6" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const maxChars = num(values, "max-chars") ?? 60;
const maxDurSec = num(values, "max-dur") ?? 5.0;
const paragraphGap = num(values, "paragraph-gap") ?? 0.6;

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);

const cacheDir = join(bundle.path, ".transcripts");

interface TimelineSeg {
	recordingSegment: number;
	timescale: number;
	start: number;
	end: number;
	outputOffset: number;
}

function timelineWithOffsets(): TimelineSeg[] {
	const segs = bundle.config.timeline?.segments ?? [];
	const out: TimelineSeg[] = [];
	let acc = 0;
	for (const s of segs) {
		const outDur = (s.end - s.start) / s.timescale;
		out.push({ ...s, outputOffset: acc });
		acc += outDur;
	}
	return out;
}

interface RawCaption {
	startSec: number;
	endSec: number;
	text: string;
	recordingSegment?: number;
}

const tsegs = timelineWithOffsets();
const hasTimeline = tsegs.length > 0;
const allCaptions: RawCaption[] = [];
let droppedByCut = 0;

for (let i = 0; i < recordings.length; i++) {
	const rec = recordings[i]!;
	const audioSource = rec.audioPath ?? rec.displayPath;
	const transcript = await transcribe({
		audioPath: audioSource,
		cacheDir,
		modelPath: typeof values.model === "string" ? values.model : undefined,
		whisperBin: typeof values["whisper-bin"] === "string" ? values["whisper-bin"] : undefined,
		language: typeof values.language === "string" ? values.language : undefined,
		refresh: values.refresh === true,
	});

	const tsForRec = tsegs.filter((t) => t.recordingSegment === i);

	for (const s of transcript.segments) {
		if (tsForRec.length === 0) {
			if (hasTimeline) {
				droppedByCut++;
				continue;
			}
			allCaptions.push({
				startSec: s.startSec,
				endSec: s.endSec,
				text: s.text,
				recordingSegment: i,
			});
			continue;
		}
		let emitted = false;
		for (const ts of tsForRec) {
			const cs = Math.max(s.startSec, ts.start);
			const ce = Math.min(s.endSec, ts.end);
			if (ce <= cs) continue;
			const outStart = ts.outputOffset + (cs - ts.start) / ts.timescale;
			const outEnd = ts.outputOffset + (ce - ts.start) / ts.timescale;
			allCaptions.push({
				startSec: outStart,
				endSec: outEnd,
				text: s.text,
				recordingSegment: i,
			});
			emitted = true;
		}
		if (!emitted) droppedByCut++;
	}
}
allCaptions.sort((a, b) => a.startSec - b.startSec);

interface CaptionSegment {
	id: string;
	start: number;
	end: number;
	text: string;
	words: never[];
}

const refined = refineCaptions(allCaptions, {
	maxChars,
	maxDurSec,
	gapForParagraphSec: paragraphGap,
});

const merged: CaptionSegment[] = refined.map((c) => ({
	id: randomUUID(),
	start: c.startSec,
	end: c.endSec,
	text: c.text,
	words: [],
}));

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
	console.log(`(dry-run: ${merged.length} caption segment(s), not saved)`);
} else {
	const captionsPath = join(bundle.path, "captions.json");
	await writeFile(captionsPath, `${JSON.stringify(captionsData, null, 2)}\n`);
	const timeline = ensureTimeline(bundle.config);
	timeline.captionSegments = merged;
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(
		`wrote ${merged.length} caption segment(s) (${recordings.length} recording(s), ${droppedByCut} dropped by cuts) to ${captionsPath} and timeline.captionSegments`,
	);
}
