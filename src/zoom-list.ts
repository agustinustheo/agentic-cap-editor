import { loadBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);
const zooms = bundle.config.timeline?.zoomSegments ?? [];

if (values.json) {
	console.log(JSON.stringify(zooms, null, 2));
} else {
	if (zooms.length === 0) {
		console.log("(no zoom segments)");
	}
	for (const [i, z] of zooms.entries()) {
		const mode =
			z.mode === "Auto"
				? "Auto"
				: `Manual(${z.mode.Manual.x}, ${z.mode.Manual.y})`;
		const extras: string[] = [];
		if (z.glideDirection && z.glideDirection !== "none") extras.push(`glide=${z.glideDirection}`);
		if (z.instantAnimation) extras.push("instant");
		console.log(
			`[${i}] [${z.start}, ${z.end}] x${z.amount} ${mode}${extras.length ? ` (${extras.join(", ")})` : ""}`,
		);
	}
}
