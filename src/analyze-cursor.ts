import { loadBundle } from "./lib/cap.ts";
import { recordingSegmentPaths, loadCursorEvents } from "./lib/cursor.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);
const segments = recordingSegmentPaths(bundle);

interface SegmentResult {
	recordingSegment: number;
	cursorPath: string | null;
	moves: number;
	clicks: number;
	firstMoveSec: number | null;
	lastMoveSec: number | null;
}

const results: SegmentResult[] = [];
for (const seg of segments) {
	if (!seg.cursorPath) {
		results.push({
			recordingSegment: seg.recordingSegment,
			cursorPath: null,
			moves: 0,
			clicks: 0,
			firstMoveSec: null,
			lastMoveSec: null,
		});
		continue;
	}
	const events = await loadCursorEvents(seg.cursorPath);
	if (!events) {
		results.push({
			recordingSegment: seg.recordingSegment,
			cursorPath: seg.cursorPath,
			moves: 0,
			clicks: 0,
			firstMoveSec: null,
			lastMoveSec: null,
		});
		continue;
	}
	results.push({
		recordingSegment: seg.recordingSegment,
		cursorPath: seg.cursorPath,
		moves: events.moves.length,
		clicks: events.clicks.length,
		firstMoveSec: events.moves[0] ? events.moves[0].time_ms / 1000 : null,
		lastMoveSec: events.moves.length
			? events.moves[events.moves.length - 1]!.time_ms / 1000
			: null,
	});
}

if (values.json) {
	console.log(JSON.stringify({ segments: results }, null, 2));
} else {
	for (const r of results) {
		console.log(`# segment ${r.recordingSegment}`);
		if (!r.cursorPath) {
			console.log("  (no cursor data — likely an instant recording)");
			continue;
		}
		console.log(`  cursor.json:  ${r.cursorPath}`);
		console.log(`  moves:        ${r.moves}`);
		console.log(`  clicks:       ${r.clicks}`);
		if (r.firstMoveSec !== null && r.lastMoveSec !== null) {
			console.log(
				`  time span:    ${r.firstMoveSec.toFixed(3)}s → ${r.lastMoveSec.toFixed(3)}s`,
			);
		}
	}
}
