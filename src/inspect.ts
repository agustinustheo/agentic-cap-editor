import { loadBundle, primaryVideoPath } from "./lib/cap.ts";
import {
	rawRecordingDurationLikeCap,
	recordingDurationsLikeCap,
} from "./lib/durations.ts";
import { timelineDuration } from "./lib/timeline.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	json: { type: "boolean", default: false },
});
const capPath = requirePositional(positionals, 0, "path-to.cap");

const bundle = await loadBundle(capPath);
const timeline = bundle.config.timeline ?? null;

let sourceDuration: number | null = null;
let recordingDurations: Awaited<ReturnType<typeof recordingDurationsLikeCap>> = [];
try {
	recordingDurations = await recordingDurationsLikeCap(bundle);
	sourceDuration = rawRecordingDurationLikeCap(recordingDurations);
} catch {
	sourceDuration = null;
}

const outputDuration = timeline ? timelineDuration(timeline.segments) : null;

const summary = {
	path: bundle.path,
	prettyName: bundle.meta.prettyName,
	platform: bundle.meta.platform,
	primaryVideo: primaryVideoPath(bundle),
	sourceDurationSec: sourceDuration,
	recordingDurations,
	timelineDurationSec: outputDuration,
	timelineInitialized: timeline !== null,
	segments: timeline?.segments ?? [],
	zoomSegments: timeline?.zoomSegments ?? [],
};

if (values.json) {
	console.log(JSON.stringify(summary, null, 2));
} else {
	console.log(`# ${summary.prettyName ?? bundle.path}`);
	console.log(`path:           ${summary.path}`);
	console.log(`platform:       ${summary.platform ?? "?"}`);
	console.log(`primary video:  ${summary.primaryVideo}`);
	console.log(
		`raw media dur:  ${sourceDuration !== null ? `${sourceDuration.toFixed(3)}s` : "(ffprobe failed)"} (Cap editor recordingDuration)`,
	);
	console.log(
		`export dur:     ${outputDuration !== null ? `${outputDuration.toFixed(3)}s` : "(no timeline yet — entire source plays)"}`,
	);
	console.log("");
	console.log(`segments (${summary.segments.length}):`);
	for (const [i, s] of summary.segments.entries()) {
		const outDur = (s.end - s.start) / s.timescale;
		console.log(
			`  [${i}] rec=${s.recordingSegment} src=[${s.start.toFixed(3)}, ${s.end.toFixed(3)}] x${s.timescale} → ${outDur.toFixed(3)}s output`,
		);
	}
	console.log("");
	console.log(`zoom segments (${summary.zoomSegments.length}):`);
	for (const [i, z] of summary.zoomSegments.entries()) {
		const mode =
			z.mode === "auto"
				? "Auto"
				: `Manual(${z.mode.manual.x.toFixed(2)}, ${z.mode.manual.y.toFixed(2)})`;
		console.log(
			`  [${i}] [${z.start.toFixed(3)}, ${z.end.toFixed(3)}] x${z.amount} ${mode}`,
		);
	}
}
