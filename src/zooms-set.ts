import { readFile } from "node:fs/promises";
import { ensureTimeline, loadBundle, saveBundle, type ZoomSegment } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	"from-json": { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const jsonPath = requirePositional(
	typeof values["from-json"] === "string" ? [values["from-json"]] : [],
	0,
	"zooms.json",
);

const zooms = JSON.parse(await readFile(jsonPath, "utf8")) as ZoomSegment[];

for (const [i, z] of zooms.entries()) {
	if (z.end <= z.start) throw new Error(`zoom ${i} has end <= start`);
	if (z.amount <= 1) throw new Error(`zoom ${i} amount must be > 1`);
	if (z.mode !== "auto" && !("manual" in z.mode)) {
		throw new Error(`zoom ${i} mode must be "auto" or { "manual": { "x": number, "y": number } }`);
	}
	if (z.mode !== "auto") {
		const { x, y } = z.mode.manual;
		if (x < 0 || x > 1 || y < 0 || y > 1) {
			throw new Error(`zoom ${i} manual target must be normalized 0..1`);
		}
	}
}

const sorted = [...zooms].sort((a, b) => a.start - b.start);
for (let i = 1; i < sorted.length; i += 1) {
	const prev = sorted[i - 1]!;
	const curr = sorted[i]!;
	if (curr.start < prev.end) {
		throw new Error(`zoom ${i} overlaps previous zoom [${prev.start}, ${prev.end}]`);
	}
}

if (values["dry-run"]) {
	console.log(JSON.stringify(sorted, null, 2));
	console.log("(dry-run: not saved)");
	process.exit(0);
}

const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);
timeline.zoomSegments = sorted;
await saveBundle(bundle, { backup: !values["no-backup"] });
console.log(`replaced zoomSegments with ${sorted.length} zoom(s) in ${capPath}`);
