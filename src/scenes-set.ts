import { readFile } from "node:fs/promises";
import { ensureTimeline, loadBundle, saveBundle, type SceneSegment } from "./lib/cap.ts";
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
	"scenes.json",
);

const scenes = JSON.parse(await readFile(jsonPath, "utf8")) as SceneSegment[];
const allowed = new Set(["default", "cameraOnly", "hideCamera"]);

for (const [i, s] of scenes.entries()) {
	if (s.end <= s.start) throw new Error(`scene ${i} has end <= start`);
	if (!allowed.has(s.mode)) throw new Error(`scene ${i} has invalid mode ${s.mode}`);
}

const sorted = [...scenes].sort((a, b) => a.start - b.start);
for (let i = 1; i < sorted.length; i += 1) {
	const prev = sorted[i - 1]!;
	const curr = sorted[i]!;
	if (curr.start < prev.end) {
		throw new Error(`scene ${i} overlaps previous scene [${prev.start}, ${prev.end}]`);
	}
}

if (values["dry-run"]) {
	console.log(JSON.stringify(sorted, null, 2));
	console.log("(dry-run: not saved)");
	process.exit(0);
}

const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);
timeline.sceneSegments = sorted;
await saveBundle(bundle, { backup: !values["no-backup"] });
console.log(`replaced sceneSegments with ${sorted.length} scene(s) in ${capPath}`);
