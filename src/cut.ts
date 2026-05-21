import {
	loadBundle,
	saveBundle,
	ensureTimeline,
	primaryVideoPath,
	ffprobeDuration,
} from "./lib/cap.ts";
import { applyCut } from "./lib/timeline.ts";
import {
	parseArgs,
	requirePositional,
	requireNum,
	num,
} from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	start: { type: "string" },
	end: { type: "string" },
	duration: { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const start = requireNum(values, "start");
const end = requireNum(values, "end");

const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);

if (timeline.segments.length === 0) {
	let dur = num(values, "duration");
	if (dur === undefined) {
		dur = await ffprobeDuration(primaryVideoPath(bundle));
	}
	timeline.segments.push({
		recordingSegment: 0,
		timescale: 1,
		start: 0,
		end: dur,
	});
}

const before = timeline.segments;
const after = applyCut(before, { start, end });
timeline.segments = after;

if (values["dry-run"]) {
	console.log(JSON.stringify({ before, after }, null, 2));
	console.log("(dry-run: not saved)");
} else {
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(
		`cut [${start}, ${end}] applied — ${before.length} segment(s) → ${after.length}`,
	);
}
