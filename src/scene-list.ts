import { loadBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);
const scenes = bundle.config.timeline?.sceneSegments ?? [];

if (values.json) {
	console.log(JSON.stringify({ scenes }, null, 2));
} else if (scenes.length === 0) {
	console.log("no scene segments");
} else {
	for (const [i, scene] of scenes.entries()) {
		console.log(
			`[${i}] [${scene.start.toFixed(3)}, ${scene.end.toFixed(3)}] ${scene.mode}`,
		);
	}
}
