import {
	access,
	copyFile,
	cp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { loadBundle } from "./lib/cap.ts";
import { closeCapApp } from "./lib/cap-app.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";

const { positionals, values } = parseArgs({
	out: { type: "string" },
	"in-place": { type: "boolean", default: false },
	force: { type: "boolean", default: false },
	model: { type: "string", default: "MossFormer2_SS_16K" },
	"keep-stem": { type: "string", default: "auto" },
	"include-system-audio": { type: "boolean", default: false },
	"dry-run": { type: "boolean", default: false },
});

const capPath = resolve(requirePositional(positionals, 0, "path-to.cap"));
const helperPath = resolve("src/audio-extract-speaker-helper.py");
const defaultModelName = "MossFormer2_SS_16K";
const defaultModelMarker = resolve(
	"checkpoints",
	defaultModelName,
	"last_best_checkpoint",
);
const defaultModelWeights = resolve(
	"checkpoints",
	defaultModelName,
	"last_best_checkpoint.pt",
);

type AudioKind = "mic" | "system";

function bundleStem(cap: string): string {
	return basename(cap).replace(/\.cap$/, "");
}

function defaultOutPath(input: string): string {
	const label = `${bundleStem(input)} Speaker Extracted.cap`;
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

async function runCommand(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(command, args);
		let stderr = "";
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (err) => {
			const maybe = err as NodeJS.ErrnoException;
			if (maybe.code === "ENOENT") {
				reject(new Error(`${command} not found in PATH`));
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
		});
	});
}

function collectTargets(
	recordings: ReturnType<typeof recordingSegmentPaths>,
	includeSystemAudio: boolean,
): Map<string, AudioKind> {
	const targets = new Map<string, AudioKind>();
	for (const recording of recordings) {
		if (recording.audioPath) targets.set(recording.audioPath, "mic");
		if (includeSystemAudio && recording.systemAudioPath) {
			targets.set(recording.systemAudioPath, "system");
		}
	}
	return targets;
}

async function runSpeakerExtraction(
	inputPath: string,
	outputPath: string,
	metaOut: string,
	model: string,
	keepStem: string,
): Promise<void> {
	const args = [
		"--from",
		"clearvoice",
		"python",
		helperPath,
		"--input",
		inputPath,
		"--output",
		outputPath,
		"--meta-out",
		metaOut,
		"--model",
		model,
		"--keep-stem",
		keepStem,
	];
	await runCommand("uvx", args);
}

async function reencodeAudio(
	inputPath: string,
	outputPath: string,
): Promise<void> {
	const ext = extname(outputPath);
	const codecArgs = ffmpegArgsForExtension(ext);
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		inputPath,
		"-vn",
		"-af",
		"highpass=f=80,lowpass=f=7800,loudnorm=I=-16:LRA=5:TP=-1.5",
		...codecArgs,
		outputPath,
	]);
}

const outPath =
	values["in-place"] === true
		? capPath
		: resolve(typeof values.out === "string" ? values.out : defaultOutPath(capPath));

if (values["in-place"] && typeof values.out === "string") {
	console.error("error: use either --in-place or --out, not both");
	process.exit(2);
}

const keepStem = String(values["keep-stem"] ?? "auto");
if (!["auto", "1", "2"].includes(keepStem)) {
	console.error(`error: invalid --keep-stem "${keepStem}" (expected auto, 1, or 2)`);
	process.exit(2);
}

if (
	(values.model ?? defaultModelName) === defaultModelName &&
	(!(await pathExists(defaultModelMarker)) || !(await pathExists(defaultModelWeights)))
) {
	console.error(
		`error: default ClearVoice model is missing. Run \`pnpm setup:clearvoice-model\` first, or pass --model with a prepared local model name.`,
	);
	process.exit(1);
}

await closeCapApp();

const bundle = await loadBundle(capPath);
const previewTargets = collectTargets(
	recordingSegmentPaths(bundle),
	values["include-system-audio"] === true,
);

if (previewTargets.size === 0) {
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
				command: "audio:extract-speaker",
				model: values.model ?? "MossFormer2_SS_16K",
				keepStem,
				files: [...previewTargets.entries()].map(([path, kind]) => ({ path, kind })),
			},
			null,
			2,
		),
	);
	process.exit(0);
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

const outputBundle = await loadBundle(outPath);
const targets = collectTargets(
	recordingSegmentPaths(outputBundle),
	values["include-system-audio"] === true,
);

const extractionMeta: Record<string, unknown> = {};

for (const [audioPath, kind] of targets) {
	const workWav = `${audioPath}.speaker-input.wav`;
	const extractedWav = `${audioPath}.speaker-output.wav`;
	const extractedMeta = `${audioPath}.speaker-output.json`;
	const tempPath = `${audioPath}.speaker${extname(audioPath)}`;
	if (values["in-place"]) {
		await copyFile(audioPath, `${audioPath}.${timestamp()}.bak`);
	}
	await mkdir(dirname(audioPath), { recursive: true });
	console.log(`extracting ${kind} speaker audio: ${audioPath}`);
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		audioPath,
		"-vn",
		"-ar",
		"16000",
		"-ac",
		"1",
		workWav,
	]);
	await runSpeakerExtraction(
		workWav,
		extractedWav,
		extractedMeta,
		String(values.model ?? "MossFormer2_SS_16K"),
		keepStem,
	);
	await reencodeAudio(extractedWav, tempPath);
	await rm(audioPath, { force: true });
	await copyFile(tempPath, audioPath);
	const meta = await readFile(extractedMeta, "utf8").then((raw) =>
		JSON.parse(raw) as Record<string, unknown>,
	);
	extractionMeta[audioPath] = {
		kind,
		...meta,
	};
	await rm(workWav, { force: true });
	await rm(extractedWav, { force: true });
	await rm(extractedMeta, { force: true });
	await rm(tempPath, { force: true });
}

const notesPath = join(outPath, ".speaker-extraction.json");
await writeFile(
	notesPath,
	`${JSON.stringify(
		{
			lastRunAt: new Date().toISOString(),
			command: "audio:extract-speaker",
			model: values.model ?? "MossFormer2_SS_16K",
			keepStem,
			inPlace: values["in-place"] === true,
			includeSystemAudio: values["include-system-audio"] === true,
			fileCount: targets.size,
			files: extractionMeta,
		},
		null,
		2,
	)}\n`,
);

console.log("");
console.log(`speaker extracted audio: ${outPath}`);
console.log(`model: ${values.model ?? "MossFormer2_SS_16K"}`);
console.log(`keep-stem: ${keepStem}`);
console.log(`tracks: ${targets.size}`);
if (outPath === capPath) {
	console.log("mode: in-place (per-file .bak backups created)");
} else {
	console.log("mode: copied bundle (source left untouched)");
}
