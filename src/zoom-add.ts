import { loadBundle, saveBundle, ensureTimeline, type ZoomSegment } from "./lib/cap.ts";
import {
	parseArgs,
	requirePositional,
	requireNum,
	num,
} from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	start: { type: "string" },
	end: { type: "string" },
	amount: { type: "string", default: "1.5" },
	x: { type: "string" },
	y: { type: "string" },
	"glide-direction": { type: "string" },
	"glide-speed": { type: "string" },
	instant: { type: "boolean", default: false },
	"edge-snap": { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const start = requireNum(values, "start");
const end = requireNum(values, "end");
const amount = requireNum(values, "amount");

if (end <= start) {
	console.error(`error: --end (${end}) must be greater than --start (${start})`);
	process.exit(2);
}

const x = num(values, "x");
const y = num(values, "y");
if ((x === undefined) !== (y === undefined)) {
	console.error("error: --x and --y must be provided together (or omit both for Auto mode)");
	process.exit(2);
}

const segment: ZoomSegment = {
	start,
	end,
	amount,
	mode: x !== undefined && y !== undefined ? { manual: { x, y } } : "auto",
};

const glideDir = values["glide-direction"];
if (typeof glideDir === "string") {
	const allowed = ["none", "left", "right", "up", "down"] as const;
	if (!(allowed as readonly string[]).includes(glideDir)) {
		console.error(`error: --glide-direction must be one of: ${allowed.join(", ")}`);
		process.exit(2);
	}
	segment.glideDirection = glideDir as (typeof allowed)[number];
}
const glideSpeed = num(values, "glide-speed");
if (glideSpeed !== undefined) segment.glideSpeed = glideSpeed;
if (values.instant) segment.instantAnimation = true;
const edgeSnap = num(values, "edge-snap");
if (edgeSnap !== undefined) segment.edgeSnapRatio = edgeSnap;

const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);

for (const existing of timeline.zoomSegments) {
	if (segment.start < existing.end && segment.end > existing.start) {
		console.error(
			`error: new zoom [${segment.start}, ${segment.end}] overlaps existing zoom [${existing.start}, ${existing.end}]. Remove the existing one first (zoom:remove) if intentional.`,
		);
		process.exit(1);
	}
}

timeline.zoomSegments.push(segment);
timeline.zoomSegments.sort((a, b) => a.start - b.start);

if (values["dry-run"]) {
	console.log(JSON.stringify(segment, null, 2));
	console.log("(dry-run: not saved)");
} else {
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(
		`added zoom [${segment.start}, ${segment.end}] x${segment.amount} (${segment.mode === "auto" ? "Auto" : "Manual"}) to ${capPath}`,
	);
}
