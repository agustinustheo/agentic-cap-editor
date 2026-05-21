import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadBundle, isInstantRecording } from "./lib/cap.ts";
import { parseArgs, requirePositional, num } from "./lib/cli.ts";

const { positionals, values } = parseArgs({
	cli: { type: "boolean", default: false },
	"via-app": { type: "boolean", default: false },
	fps: { type: "string", default: "60" },
	width: { type: "string", default: "1920" },
	height: { type: "string", default: "1080" },
	compression: { type: "string", default: "Web" },
	"optimize-filesize": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);

if (isInstantRecording(bundle)) {
	const output = join(bundle.path, "content/output.mp4");
	console.log(
		`This is an instant recording — no rendering is needed. The mp4 is already at:\n  ${output}`,
	);
	process.exit(0);
}

if (values["via-app"] || (!values.cli && process.platform === "darwin")) {
	if (process.platform !== "darwin") {
		console.error("error: --via-app is only supported on macOS. Use --cli on Linux/Windows.");
		process.exit(2);
	}
	await new Promise<void>((res, rej) => {
		const proc = spawn("open", [bundle.path], { stdio: "inherit" });
		proc.on("close", (code) => (code === 0 ? res() : rej(new Error(`open exited ${code}`))));
	});
	console.log(`opened ${bundle.path} in Cap.app — use the Export button to render mp4.`);
	process.exit(0);
}

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..");
const exporterBin = join(repoRoot, ".repos/Cap/target/release/examples/export-cli");

const exporterExists = await access(exporterBin).then(
	() => true,
	() => false,
);
if (!exporterExists) {
	console.error(
		`export-cli not built. One-time setup:
  pnpm render:build

This compiles Cap's export pipeline in .repos/Cap (5–10 min, needs the same
system deps Cap itself needs: rustup toolchain + ffmpeg dev libs).

If you'd rather export interactively, run:
  pnpm render ${capPath} --via-app    (macOS only — opens in Cap.app)`,
	);
	process.exit(1);
}

const compression = String(values.compression);
const validCompressions = ["Maximum", "Social", "Web", "Potato"];
if (!validCompressions.includes(compression)) {
	console.error(
		`error: --compression must be one of: ${validCompressions.join(", ")}  (got "${compression}")`,
	);
	process.exit(2);
}

const settings = {
	fps: num(values, "fps") ?? 60,
	resolution_base: {
		x: num(values, "width") ?? 1920,
		y: num(values, "height") ?? 1080,
	},
	compression,
	custom_bpp: null,
	force_ffmpeg_decoder: false,
	optimize_filesize: values["optimize-filesize"] === true,
};

console.log(`rendering ${bundle.path} → mp4 …`);
console.log(`  settings: ${JSON.stringify(settings)}`);

await new Promise<void>((res, rej) => {
	const proc = spawn(exporterBin, [bundle.path, "mp4", JSON.stringify(settings)], {
		stdio: "inherit",
	});
	proc.on("close", (code) =>
		code === 0 ? res() : rej(new Error(`export-cli exited ${code}`)),
	);
});

const outputPath = join(bundle.path, "output/result.mp4");
console.log(`\nrender complete: ${outputPath}`);
