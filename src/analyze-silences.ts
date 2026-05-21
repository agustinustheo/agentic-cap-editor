import { loadBundle } from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { detectSilences } from "./lib/ffmpeg.ts";
import { parseArgs, requirePositional, num } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	noise: { type: "string", default: "-30" },
	"min-duration": { type: "string", default: "0.4" },
	padding: { type: "string", default: "0.1" },
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const noiseDb = num(values, "noise") ?? -30;
const minDurationSec = num(values, "min-duration") ?? 0.4;
const padding = num(values, "padding") ?? 0.1;

const bundle = await loadBundle(capPath);
const segments = recordingSegmentPaths(bundle);

interface SegmentResult {
	recordingSegment: number;
	source: string;
	ranges: { start: number; end: number; duration: number }[];
}

const results: SegmentResult[] = [];
for (const seg of segments) {
	const source = seg.audioPath ?? seg.displayPath;
	const ranges = await detectSilences(source, { noiseDb, minDurationSec });
	const padded = ranges
		.map((r) => ({
			start: r.start + padding,
			end: r.end - padding,
			duration: r.end - r.start - 2 * padding,
		}))
		.filter((r) => r.end > r.start && r.duration >= minDurationSec);
	results.push({ recordingSegment: seg.recordingSegment, source, ranges: padded });
}

if (values.json) {
	console.log(JSON.stringify({ noiseDb, minDurationSec, padding, segments: results }, null, 2));
} else {
	for (const r of results) {
		console.log(`# segment ${r.recordingSegment}  (${r.source})`);
		if (r.ranges.length === 0) {
			console.log("  (no silences detected)");
			continue;
		}
		for (const s of r.ranges) {
			console.log(`  ${s.start.toFixed(3)} → ${s.end.toFixed(3)}  (${s.duration.toFixed(3)}s)`);
		}
	}
}
