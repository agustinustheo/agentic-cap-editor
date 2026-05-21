import {
	loadBundle,
	saveBundle,
	ensureTimeline,
	type ZoomSegment,
} from "./lib/cap.ts";
import {
	recordingSegmentPaths,
	loadCursorEvents,
	cursorPositionAt,
} from "./lib/cursor.ts";
import { parseArgs, requirePositional, num } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	amount: { type: "string", default: "1.6" },
	lead: { type: "string", default: "0.5" },
	hold: { type: "string", default: "1.5" },
	cluster: { type: "string", default: "2.0" },
	"min-gap": { type: "string", default: "1.0" },
	mode: { type: "string", default: "auto" },
	apply: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const amount = num(values, "amount") ?? 1.6;
const lead = num(values, "lead") ?? 0.5;
const hold = num(values, "hold") ?? 1.5;
const cluster = num(values, "cluster") ?? 2.0;
const minGap = num(values, "min-gap") ?? 1.0;
const mode = String(values.mode ?? "auto");
if (mode !== "auto" && mode !== "manual") {
	console.error('error: --mode must be "auto" or "manual"');
	process.exit(2);
}

const bundle = await loadBundle(capPath);
const segments = recordingSegmentPaths(bundle);

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

function translateToOutput(
	tsegs: TimelineSeg[],
	recordingIdx: number,
	recordingTimeSec: number,
): number | null {
	for (const ts of tsegs) {
		if (ts.recordingSegment !== recordingIdx) continue;
		if (recordingTimeSec >= ts.start && recordingTimeSec <= ts.end) {
			return ts.outputOffset + (recordingTimeSec - ts.start) / ts.timescale;
		}
	}
	return null;
}

const tsegs = timelineWithOffsets();
const timelineDuration =
	tsegs.length > 0
		? tsegs.reduce(
				(max, s) => Math.max(max, s.outputOffset + (s.end - s.start) / s.timescale),
				0,
			)
		: null;

interface ClickPoint {
	timeSec: number;
	x: number;
	y: number;
}

const points: ClickPoint[] = [];
let droppedClicks = 0;
for (let i = 0; i < segments.length; i++) {
	const seg = segments[i]!;
	if (!seg.cursorPath) continue;
	const events = await loadCursorEvents(seg.cursorPath);
	if (!events) continue;
	for (const c of events.clicks) {
		if (!c.down) continue;
		const pos = cursorPositionAt(events, c.time_ms);
		if (!pos) continue;
		const recTime = c.time_ms / 1000;
		if (tsegs.length === 0) {
			points.push({ timeSec: recTime, x: pos.x, y: pos.y });
			continue;
		}
		const outTime = translateToOutput(tsegs, i, recTime);
		if (outTime === null) {
			droppedClicks++;
			continue;
		}
		points.push({ timeSec: outTime, x: pos.x, y: pos.y });
	}
}
points.sort((a, b) => a.timeSec - b.timeSec);

interface Cluster {
	firstTime: number;
	lastTime: number;
	avgX: number;
	avgY: number;
	clickCount: number;
}
const clusters: Cluster[] = [];
for (const p of points) {
	const last = clusters[clusters.length - 1];
	if (last && p.timeSec - last.lastTime <= cluster) {
		last.lastTime = p.timeSec;
		last.avgX = (last.avgX * last.clickCount + p.x) / (last.clickCount + 1);
		last.avgY = (last.avgY * last.clickCount + p.y) / (last.clickCount + 1);
		last.clickCount += 1;
	} else {
		clusters.push({ firstTime: p.timeSec, lastTime: p.timeSec, avgX: p.x, avgY: p.y, clickCount: 1 });
	}
}

const proposed: ZoomSegment[] = [];
for (const cl of clusters) {
	const start = Math.max(0, cl.firstTime - lead);
	const unclampedEnd = cl.lastTime + hold;
	const end = timelineDuration === null ? unclampedEnd : Math.min(unclampedEnd, timelineDuration);
	if (end - start < 0.2) continue;
	const seg: ZoomSegment = {
		start,
		end,
		amount,
		mode:
			mode === "manual"
				? { Manual: { x: Number(cl.avgX.toFixed(4)), y: Number(cl.avgY.toFixed(4)) } }
				: "Auto",
	};
	if (proposed.length > 0) {
		const prev = proposed[proposed.length - 1]!;
		if (seg.start < prev.end + minGap) {
			prev.end = seg.end;
			continue;
		}
	}
	proposed.push(seg);
}

if (values.json) {
	console.log(JSON.stringify({ clusters: clusters.length, proposed, droppedClicks }, null, 2));
} else if (!values.apply) {
	console.log(
		`clicks: ${points.length} (${droppedClicks} dropped by cuts), clusters: ${clusters.length}`,
	);
	console.log(`proposed zooms (${proposed.length}):`);
	for (const z of proposed) {
		const m =
			z.mode === "Auto"
				? "Auto"
				: `Manual(${z.mode.Manual.x.toFixed(3)}, ${z.mode.Manual.y.toFixed(3)})`;
		console.log(`  [${z.start.toFixed(3)}, ${z.end.toFixed(3)}] x${z.amount} ${m}`);
	}
	console.log("");
	console.log("pass --apply to write these to project-config.json");
}

if (values.apply) {
	const timeline = ensureTimeline(bundle.config);
	for (const z of proposed) {
		const conflict = timeline.zoomSegments.find(
			(e) => z.start < e.end && z.end > e.start,
		);
		if (conflict) {
			console.error(
				`skipping [${z.start}, ${z.end}] — overlaps existing zoom [${conflict.start}, ${conflict.end}]`,
			);
			continue;
		}
		timeline.zoomSegments.push(z);
	}
	timeline.zoomSegments.sort((a, b) => a.start - b.start);
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(`applied ${proposed.length} zoom(s) to ${capPath}`);
}
