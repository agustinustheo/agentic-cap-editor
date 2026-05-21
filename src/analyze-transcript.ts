import { join } from "node:path";
import { loadBundle } from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { transcribe } from "./lib/whisper.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	model: { type: "string" },
	"whisper-bin": { type: "string" },
	language: { type: "string" },
	"max-segment-len": { type: "string" },
	refresh: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);
const segments = recordingSegmentPaths(bundle);

const maxLen =
	typeof values["max-segment-len"] === "string"
		? Number(values["max-segment-len"])
		: undefined;

const cacheDir = join(bundle.path, ".transcripts");

interface SegmentTranscript {
	recordingSegment: number;
	source: string | null;
	model: string | null;
	segmentCount: number;
	segments: { startSec: number; endSec: number; text: string }[];
}

const results: SegmentTranscript[] = [];
for (const seg of segments) {
	const source = seg.audioPath ?? seg.displayPath;
	const transcript = await transcribe({
		audioPath: source,
		cacheDir,
		modelPath: typeof values.model === "string" ? values.model : undefined,
		whisperBin: typeof values["whisper-bin"] === "string" ? values["whisper-bin"] : undefined,
		language: typeof values.language === "string" ? values.language : undefined,
		maxSegmentLen: maxLen,
		refresh: values.refresh === true,
	});
	results.push({
		recordingSegment: seg.recordingSegment,
		source: transcript.source,
		model: transcript.model,
		segmentCount: transcript.segments.length,
		segments: transcript.segments,
	});
}

if (values.json) {
	console.log(JSON.stringify({ segments: results }, null, 2));
} else {
	for (const r of results) {
		console.log(`# recording ${r.recordingSegment}  (model ${r.model}, ${r.segmentCount} segments)`);
		for (const s of r.segments) {
			console.log(`  [${s.startSec.toFixed(2)} → ${s.endSec.toFixed(2)}] ${s.text}`);
		}
	}
}
