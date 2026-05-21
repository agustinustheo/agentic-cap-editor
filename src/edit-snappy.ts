import { cp, rm, access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import { closeCapApp } from "./lib/cap-app.ts";

const { positionals, values } = parseArgs({
	name: { type: "string" },
	force: { type: "boolean", default: false },
	"no-captions": { type: "boolean", default: false },
	"no-zooms": { type: "boolean", default: false },
	"open": { type: "boolean", default: false },
});

requirePositional(positionals, 0, "source.cap");
const sources = positionals;

function defaultName(source: string): string {
	return basename(source).replace(/\.cap$/, "").replace(/\s*\(Window\)\s*/g, " ").trim() + " Edited";
}

function safeProjectName(name: string): string {
	return basename(name.replace(/\.cap$/, ""))
		.replace(/[/:]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const outputName =
	typeof values.name === "string"
		? safeProjectName(values.name)
		: sources.length === 1
			? safeProjectName(defaultName(sources[0]!))
			: "Merged Snappy Edit";
if (!outputName) {
	console.error("error: --name must contain at least one filename-safe character");
	process.exit(2);
}
const outputCap = resolve("recordings/edited", `${outputName}.cap`);

async function exists(path: string): Promise<boolean> {
	return await access(path).then(
		() => true,
		() => false,
	);
}

async function run(cmd: string, args: string[]): Promise<void> {
	console.log(`$ ${[cmd, ...args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a))].join(" ")}`);
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(cmd, args, { stdio: "inherit" });
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${cmd} exited ${code}`));
		});
	});
}

await closeCapApp();

if (await exists(outputCap)) {
	if (!values.force) {
		console.error(`error: ${outputCap} already exists. Pass --force to replace it.`);
		process.exit(1);
	}
	await rm(outputCap, { recursive: true, force: true });
}

if (sources.length === 1) {
	await cp(sources[0]!, outputCap, { recursive: true });
	console.log(`copied ${sources[0]} -> ${outputCap}`);
} else {
	await run("pnpm", ["merge", outputName, ...sources, ...(values.force ? ["--force"] : [])]);
}

await run("pnpm", ["inspect", outputCap]);
await run("pnpm", [
	"suggest:cuts",
	outputCap,
	"--clause-aware",
	"--min-duration",
	"0.35",
	"--padding",
	"0.08",
	"--apply",
]);

if (!values["no-captions"]) {
	await run("pnpm", [
		"captions:add",
		outputCap,
		"--max-chars",
		"54",
		"--max-dur",
		"4.2",
		"--paragraph-gap",
		"0.45",
	]);
}

if (!values["no-zooms"]) {
	await run("pnpm", [
		"suggest:zooms",
		outputCap,
		"--amount",
		"1.65",
		"--lead",
		"0.35",
		"--hold",
		"1.1",
		"--cluster",
		"1.6",
		"--min-gap",
		"0.55",
		"--apply",
	]);
}

await run("pnpm", ["validate", outputCap, "--expect-edited"]);

if (values.open) {
	await run("pnpm", ["render", outputCap, "--via-app"]);
} else {
	console.log("");
	console.log(`ready: ${outputCap}`);
	console.log("Preview only after validation. To open in Cap.app:");
	console.log(`  pnpm render ${JSON.stringify(outputCap)} --via-app`);
}
