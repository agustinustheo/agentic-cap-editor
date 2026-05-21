import { loadBundle, saveBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const indexStr = requirePositional(positionals, 1, "index");
const index = Number(indexStr);
if (!Number.isInteger(index) || index < 0) {
	console.error(`error: index must be a non-negative integer, got "${indexStr}"`);
	process.exit(2);
}

const bundle = await loadBundle(capPath);
const zooms = bundle.config.timeline?.zoomSegments;
if (!zooms || index >= zooms.length) {
	console.error(`error: index ${index} out of range (have ${zooms?.length ?? 0} zoom segments)`);
	process.exit(1);
}
const [removed] = zooms.splice(index, 1);
await saveBundle(bundle, { backup: !values["no-backup"] });
console.log(`removed zoom [${removed?.start}, ${removed?.end}] from ${capPath}`);
