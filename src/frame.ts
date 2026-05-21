import { resolve } from "node:path";
import { loadBundle, primaryVideoPath } from "./lib/cap.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { extractFrame } from "./lib/ffmpeg.ts";
import { parseArgs, requirePositional, requireNum } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	at: { type: "string" },
	out: { type: "string" },
	"recording-time": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const at = requireNum(values, "at");
const bundle = await loadBundle(capPath);

interface ResolvedFrame {
	source: string;
	at: number;
}

function resolveFrame(): ResolvedFrame {
	if (values["recording-time"]) {
		return { source: primaryVideoPath(bundle), at };
	}
	const tlSegs = bundle.config.timeline?.segments ?? [];
	if (tlSegs.length === 0) {
		return { source: primaryVideoPath(bundle), at };
	}
	const recordings = recordingSegmentPaths(bundle);
	let acc = 0;
	for (const ts of tlSegs) {
		const dur = (ts.end - ts.start) / ts.timescale;
		if (at >= acc && at <= acc + dur) {
			const recLocal = ts.start + (at - acc) * ts.timescale;
			const rec = recordings[ts.recordingSegment];
			if (!rec) break;
			return { source: rec.displayPath, at: recLocal };
		}
		acc += dur;
	}
	console.error(
		`error: time ${at}s is past timeline duration ${acc.toFixed(3)}s. Pass --recording-time to extract from recording 0's local time instead.`,
	);
	process.exit(1);
}

const { source, at: srcAt } = resolveFrame();
const outPath = resolve(
	typeof values.out === "string" ? values.out : `frame_at_${at.toFixed(3)}.png`,
);

await extractFrame(source, { at: srcAt, outPath });
console.log(`${outPath}  (source: ${source}, recording-local t=${srcAt.toFixed(3)}s)`);
