import { loadBundle, saveBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const indexRaw = requirePositional(positionals, 1, "scene-index");
const index = Number(indexRaw);

if (!Number.isInteger(index) || index < 0) {
	console.error(`error: scene index must be a non-negative integer, got "${indexRaw}"`);
	process.exit(2);
}

const bundle = await loadBundle(capPath);
const scenes = bundle.config.timeline?.sceneSegments;
if (!scenes || scenes.length === 0) {
	console.error("error: bundle has no scene segments");
	process.exit(1);
}
if (index >= scenes.length) {
	console.error(`error: scene index ${index} is out of range 0..${scenes.length - 1}`);
	process.exit(1);
}

const [removed] = scenes.splice(index, 1);
if (!removed) {
	console.error(`error: could not remove scene ${index}`);
	process.exit(1);
}

if (values["dry-run"]) {
	console.log(JSON.stringify(removed, null, 2));
	console.log("(dry-run: not saved)");
} else {
	await saveBundle(bundle, { backup: !values["no-backup"] });
	console.log(
		`removed scene ${index} [${removed.start}, ${removed.end}] ${removed.mode} from ${capPath}`,
	);
}
