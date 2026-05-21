import { loadBundle } from "./lib/cap.ts";
import { recordingSegmentPaths, loadCursorEvents, cursorPositionAt } from "./lib/cursor.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);
const segments = recordingSegmentPaths(bundle);

interface ClickInfo {
	recordingSegment: number;
	timeSec: number;
	x: number;
	y: number;
	cursorId: string;
	modifiers: string[];
}

const clicks: ClickInfo[] = [];
for (const seg of segments) {
	if (!seg.cursorPath) continue;
	const events = await loadCursorEvents(seg.cursorPath);
	if (!events) continue;
	for (const c of events.clicks) {
		if (!c.down) continue;
		const pos = cursorPositionAt(events, c.time_ms);
		if (!pos) continue;
		clicks.push({
			recordingSegment: seg.recordingSegment,
			timeSec: c.time_ms / 1000,
			x: pos.x,
			y: pos.y,
			cursorId: c.cursor_id,
			modifiers: c.active_modifiers,
		});
	}
}

if (values.json) {
	console.log(JSON.stringify({ clicks }, null, 2));
} else {
	if (clicks.length === 0) {
		console.log("(no click-down events)");
	}
	for (const c of clicks) {
		const mods = c.modifiers.length ? ` [${c.modifiers.join("+")}]` : "";
		console.log(
			`seg=${c.recordingSegment}  t=${c.timeSec.toFixed(3)}s  pos=(${c.x.toFixed(3)}, ${c.y.toFixed(3)})  cursor=${c.cursorId}${mods}`,
		);
	}
}
