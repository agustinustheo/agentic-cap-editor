import {
	loadBundle,
	saveBundle,
	ensureTimeline,
	type SceneMode,
	type SceneSegment,
} from "./lib/cap.ts";
import { parseArgs, requirePositional, requireNum } from "./lib/cli.ts";
import { timelineDuration } from "./lib/timeline.ts";

const { positionals, values } = parseArgs({
	start: { type: "string" },
	end: { type: "string" },
	mode: { type: "string", default: "hideCamera" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const start = requireNum(values, "start");
const end = requireNum(values, "end");
const rawMode = values.mode;
const allowedModes = ["default", "cameraOnly", "hideCamera"] as const;

if (typeof rawMode !== "string" || !(allowedModes as readonly string[]).includes(rawMode)) {
	console.error(`error: --mode must be one of: ${allowedModes.join(", ")}`);
	process.exit(2);
}

if (end <= start) {
	console.error(`error: --end (${end}) must be greater than --start (${start})`);
	process.exit(2);
}

const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);
const outputDuration = timelineDuration(timeline.segments);

if (start < 0 || end > outputDuration + 1e-6) {
	console.error(
		`error: scene [${start}, ${end}] is outside output duration ${outputDuration.toFixed(3)}s`,
	);
	process.exit(2);
}

for (const existing of timeline.sceneSegments ?? []) {
	if (start < existing.end && end > existing.start) {
		console.error(
			`error: new scene [${start}, ${end}] overlaps existing scene [${existing.start}, ${existing.end}]. Remove the existing one first (scene:remove) if intentional.`,
		);
		process.exit(1);
	}
}

const segment: SceneSegment = {
	start,
	end,
	mode: rawMode as SceneMode,
};

timeline.sceneSegments ??= [];
timeline.sceneSegments.push(segment);
timeline.sceneSegments.sort((a, b) => a.start - b.start);

if (values["dry-run"]) {
	console.log(JSON.stringify(segment, null, 2));
	console.log("(dry-run: not saved)");
} else {
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(`added scene [${start}, ${end}] ${segment.mode} to ${capPath}`);
}
