import {
	access,
	copyFile,
	cp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { closeCapApp } from "./lib/cap-app.ts";

const { positionals, values } = parseArgs({
	out: { type: "string" },
	"in-place": { type: "boolean", default: false },
	force: { type: "boolean", default: false },
	preset: { type: "string", default: "voice" },
	"include-system-audio": { type: "boolean", default: false },
	"dry-run": { type: "boolean", default: false },
});

const capPath = resolve(requirePositional(positionals, 0, "path-to.cap"));

function bundleStem(cap: string): string {
	return basename(cap).replace(/\.cap$/, "");
}

function defaultOutPath(input: string): string {
	const label = `${bundleStem(input)} Sanitized.cap`;
	const parent = basename(dirname(input));
	if (parent === "originals") {
		return resolve(dirname(dirname(input)), "edited", label);
	}
	return resolve(dirname(input), label);
}

function timestamp(): string {
	return new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace(/T/, "_")
		.slice(0, -5);
}

async function pathExists(path: string): Promise<boolean> {
	return await access(path).then(
		() => true,
		() => false,
	);
}

function ffmpegArgsForExtension(ext: string): string[] {
	switch (ext.toLowerCase()) {
		case ".ogg":
		case ".opus":
			return ["-c:a", "libopus", "-b:a", "96k"];
		case ".mp3":
			return ["-c:a", "libmp3lame", "-q:a", "2"];
		case ".wav":
			return ["-c:a", "pcm_s16le"];
		case ".m4a":
		case ".mp4":
			return ["-c:a", "aac", "-b:a", "128k"];
		default:
			throw new Error(`unsupported audio extension ${ext}`);
	}
}

function presetFilter(preset: string): string {
	switch (preset) {
		case "light":
			return [
				"highpass=f=70",
				"lowpass=f=9000",
				"afftdn=nf=-20:nt=w",
				"loudnorm=I=-17:LRA=8:TP=-1.5",
			].join(",");
		case "voice":
			return [
				"highpass=f=80",
				"lowpass=f=8000",
				"afftdn=nf=-25:nt=w",
				"anlmdn=s=7:p=0.002:r=0.01",
				"loudnorm=I=-16:LRA=7:TP=-1.5",
			].join(",");
		case "strong":
			return [
				"highpass=f=100",
				"lowpass=f=7000",
				"afftdn=nf=-30:nt=w",
				"anlmdn=s=10:p=0.001:r=0.01",
				"loudnorm=I=-16:LRA=6:TP=-1.5",
			].join(",");
		default:
			throw new Error(`invalid --preset "${preset}" (expected light, voice, or strong)`);
	}
}

async function runFfmpegAudio(
	inputPath: string,
	outputPath: string,
	filter: string,
): Promise<void> {
	const ext = extname(outputPath);
	const codecArgs = ffmpegArgsForExtension(ext);
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-vn",
			"-af",
			filter,
			...codecArgs,
			outputPath,
		]);
		let stderr = "";
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("ffmpeg not found in PATH. Install: brew install ffmpeg"));
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
		});
	});
}

const outPath =
	values["in-place"] === true
		? capPath
		: resolve(typeof values.out === "string" ? values.out : defaultOutPath(capPath));

if (values["in-place"] && typeof values.out === "string") {
	console.error("error: use either --in-place or --out, not both");
	process.exit(2);
}

if (outPath !== capPath) {
	if (await pathExists(outPath)) {
		if (!values.force) {
			console.error(`error: ${outPath} already exists. Pass --force to replace it.`);
			process.exit(1);
		}
		await rm(outPath, { recursive: true, force: true });
	}
	await cp(capPath, outPath, { recursive: true });
}

await closeCapApp();

const bundle = await loadBundle(outPath);
const recordings = recordingSegmentPaths(bundle);
const filter = presetFilter(String(values.preset ?? "voice"));

const targets = new Map<string, "mic" | "system">();
for (const recording of recordings) {
	if (recording.audioPath) targets.set(recording.audioPath, "mic");
	if (values["include-system-audio"] && recording.systemAudioPath) {
		targets.set(recording.systemAudioPath, "system");
	}
}

if (targets.size === 0) {
	console.error("error: no audio tracks found in this .cap bundle");
	process.exit(1);
}

if (values["dry-run"]) {
	console.log(
		JSON.stringify(
			{
				input: capPath,
				output: outPath,
				inPlace: values["in-place"] === true,
				preset: values.preset ?? "voice",
				filter,
				files: [...targets.entries()].map(([path, kind]) => ({ path, kind })),
			},
			null,
			2,
		),
	);
	process.exit(0);
}

for (const [audioPath, kind] of targets) {
	const tempPath = `${audioPath}.sanitized${extname(audioPath)}`;
	if (values["in-place"]) {
		await copyFile(audioPath, `${audioPath}.${timestamp()}.bak`);
	}
	await mkdir(dirname(audioPath), { recursive: true });
	console.log(`sanitizing ${kind} audio: ${audioPath}`);
	await runFfmpegAudio(audioPath, tempPath, filter);
	await rm(audioPath, { force: true });
	await copyFile(tempPath, audioPath);
	await rm(tempPath, { force: true });
}

const notesPath = join(outPath, ".sanitized-audio.json");
const priorNotes = await readFile(notesPath, "utf8")
	.then((raw) => JSON.parse(raw) as Record<string, unknown>)
	.catch(() => ({}));
const nextNotes = {
	...priorNotes,
	lastRunAt: new Date().toISOString(),
	preset: values.preset ?? "voice",
	filter,
	inPlace: values["in-place"] === true,
	includeSystemAudio: values["include-system-audio"] === true,
	fileCount: targets.size,
};
await writeFile(notesPath, `${JSON.stringify(nextNotes, null, 2)}\n`);

console.log("");
console.log(`audio sanitized: ${outPath}`);
console.log(`preset: ${values.preset ?? "voice"}`);
console.log(`tracks: ${targets.size}`);
if (outPath === capPath) {
	console.log("mode: in-place (per-file .bak backups created)");
} else {
	console.log("mode: copied bundle (source left untouched)");
}
