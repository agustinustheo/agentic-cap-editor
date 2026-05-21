import { resolve } from "node:path";
import { loadBundle, primaryVideoPath } from "./lib/cap.ts";
import { extractFrame } from "./lib/ffmpeg.ts";
import { parseArgs, requirePositional, requireNum } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	at: { type: "string" },
	out: { type: "string" },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const at = requireNum(values, "at");
const bundle = await loadBundle(capPath);
const source = primaryVideoPath(bundle);

const outPath = resolve(
	typeof values.out === "string" ? values.out : `frame_at_${at.toFixed(3)}.png`,
);

await extractFrame(source, { at, outPath });
console.log(outPath);
