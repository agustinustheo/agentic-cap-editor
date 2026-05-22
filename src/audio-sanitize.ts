import {
	access,
	chmod,
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	rename,
	writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { loadBundle } from "./lib/cap.ts";
import { closeCapApp } from "./lib/cap-app.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";

const DEFAULT_ARNNDN_MODEL_URL =
	"https://raw.githubusercontent.com/richardpl/arnndn-models/master/std.rnnn";
const DEFAULT_ARNNDN_MODEL_PATH = join(
	homedir(),
	".cache",
	"agentic-cap-editor",
	"arnndn",
	"std.rnnn",
);
const DEFAULT_DEEP_FILTER_VERSION = "0.5.6";
const DEFAULT_DEEP_FILTER_PATH = join(
	homedir(),
	".cache",
	"agentic-cap-editor",
	"deep-filter",
	DEFAULT_DEEP_FILTER_VERSION,
	"deep-filter",
);

const { positionals, values } = parseArgs({
	out: { type: "string" },
	"in-place": { type: "boolean", default: false },
	force: { type: "boolean", default: false },
	preset: { type: "string", default: "voice" },
	engine: { type: "string", default: "auto" },
	model: { type: "string" },
	"model-url": { type: "string" },
	mix: { type: "string" },
	"deep-filter-bin": { type: "string" },
	"deep-filter-version": { type: "string", default: DEFAULT_DEEP_FILTER_VERSION },
	"no-model-download": { type: "boolean", default: false },
	"no-binary-download": { type: "boolean", default: false },
	"atten-lim-db": { type: "string" },
	"post-filter": { type: "boolean", default: false },
	"pf-beta": { type: "string" },
	"include-system-audio": { type: "boolean", default: false },
	"dry-run": { type: "boolean", default: false },
});

const capPath = resolve(requirePositional(positionals, 0, "path-to.cap"));

type AudioKind = "mic" | "system";
type AudioEngine = "ffmpeg" | "deepfilter";
type EngineValue = AudioEngine | "auto";

type ArnndnMeta = {
	modelPath?: string;
	modelDownloaded: boolean;
	modelSource?: string;
	mix?: number;
};

type DeepFilterMeta = {
	binaryPath: string;
	binaryDownloaded: boolean;
	binarySource: string;
	attenLimDb: number;
	postFilter: boolean;
	postFilterBeta?: number;
};

type AudioPlan = {
	engine: AudioEngine;
	label: string;
	ffmpegFilter?: string;
	postEncodeFilter?: string;
	arnndn?: ArnndnMeta;
	deepfilter?: DeepFilterMeta;
};

type TrackPreview = {
	path: string;
	kind: AudioKind;
	engine: AudioEngine;
};

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

function parseNumberFlag(
	raw: string | boolean | undefined,
	name: string,
	range?: { min: number; max: number },
): number | undefined {
	if (typeof raw !== "string") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`invalid ${name} "${raw}"`);
	}
	if (range && (value < range.min || value > range.max)) {
		throw new Error(`invalid ${name} "${raw}" (expected ${range.min}..${range.max})`);
	}
	return value;
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

function filterString(segments: string[]): string {
	return segments.join(",");
}

function escapeFilterValue(value: string): string {
	return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll(",", "\\,").replaceAll(":", "\\:")}'`;
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	await mkdir(dirname(outputPath), { recursive: true });
	const tempPath = `${outputPath}.download`;
	const bytes = new Uint8Array(await response.arrayBuffer());
	await writeFile(tempPath, bytes);
	await rename(tempPath, outputPath);
}

async function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string },
): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
		});
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

async function ensureArnndnModel(
	modelArg: string | boolean | undefined,
	modelUrlArg: string | boolean | undefined,
	allowDownload: boolean,
): Promise<{ path: string; downloaded: boolean; source: string }> {
	const modelPath =
		typeof modelArg === "string" ? resolve(modelArg) : DEFAULT_ARNNDN_MODEL_PATH;
	if (await pathExists(modelPath)) {
		return {
			path: modelPath,
			downloaded: false,
			source: typeof modelArg === "string" ? "custom" : "default-cache",
		};
	}
	if (!allowDownload) {
		throw new Error(
			`arnndn model not found at ${modelPath}. Pass --model <path> or allow auto-download.`,
		);
	}
	const modelUrl =
		typeof modelUrlArg === "string" ? modelUrlArg : DEFAULT_ARNNDN_MODEL_URL;
	await downloadFile(modelUrl, modelPath);
	return {
		path: modelPath,
		downloaded: true,
		source: typeof modelArg === "string" ? "custom-url" : "default-download",
	};
}

function deepFilterDownloadUrl(version: string): string {
	const key = `${process.platform}-${process.arch}`;
	switch (key) {
		case "darwin-arm64":
			return `https://github.com/Rikorose/DeepFilterNet/releases/download/v${version}/deep-filter-${version}-aarch64-apple-darwin`;
		case "darwin-x64":
			return `https://github.com/Rikorose/DeepFilterNet/releases/download/v${version}/deep-filter-${version}-x86_64-apple-darwin`;
		case "linux-arm64":
			return `https://github.com/Rikorose/DeepFilterNet/releases/download/v${version}/deep-filter-${version}-aarch64-unknown-linux-gnu`;
		case "linux-arm":
			return `https://github.com/Rikorose/DeepFilterNet/releases/download/v${version}/deep-filter-${version}-armv7-unknown-linux-gnueabihf`;
		case "linux-x64":
			return `https://github.com/Rikorose/DeepFilterNet/releases/download/v${version}/deep-filter-${version}-x86_64-unknown-linux-musl`;
		default:
			throw new Error(`deep-filter binary download not configured for ${key}`);
	}
}

async function ensureDeepFilterBinary(
	customPathArg: string | boolean | undefined,
	versionArg: string | boolean | undefined,
	allowDownload: boolean,
): Promise<{ path: string; downloaded: boolean; source: string }> {
	if (typeof customPathArg === "string") {
		const customPath = resolve(customPathArg);
		if (!(await pathExists(customPath))) {
			throw new Error(`deep-filter binary not found at ${customPath}`);
		}
		return { path: customPath, downloaded: false, source: "custom" };
	}
	const version =
		typeof versionArg === "string" ? versionArg : DEFAULT_DEEP_FILTER_VERSION;
	const binaryPath =
		version === DEFAULT_DEEP_FILTER_VERSION
			? DEFAULT_DEEP_FILTER_PATH
			: join(
					homedir(),
					".cache",
					"agentic-cap-editor",
					"deep-filter",
					version,
					"deep-filter",
				);
	if (await pathExists(binaryPath)) {
		return { path: binaryPath, downloaded: false, source: "default-cache" };
	}
	if (!allowDownload) {
		throw new Error(
			`deep-filter binary not found at ${binaryPath}. Pass --deep-filter-bin <path> or allow auto-download.`,
		);
	}
	await downloadFile(deepFilterDownloadUrl(version), binaryPath);
	await chmod(binaryPath, 0o755);
	return { path: binaryPath, downloaded: true, source: "default-download" };
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

function resolveEngine(raw: string | boolean | undefined, preset: string): EngineValue {
	if (raw === undefined || raw === "auto") {
		return preset === "light" ? "ffmpeg" : "auto";
	}
	if (raw === "ffmpeg" || raw === "deepfilter" || raw === "auto") {
		return raw;
	}
	throw new Error(`invalid --engine "${String(raw)}" (expected auto, ffmpeg, or deepfilter)`);
}

async function buildFfmpegPlan(preset: string): Promise<AudioPlan> {
	switch (preset) {
		case "light":
			return {
				engine: "ffmpeg",
				label: "ffmpeg-light",
				ffmpegFilter: filterString([
					"highpass=f=70",
					"lowpass=f=9000",
					"afftdn=nf=-20:nt=w",
					"loudnorm=I=-17:LRA=8:TP=-1.5",
				]),
			};
		case "voice":
		case "neural": {
			const model = await ensureArnndnModel(
				values.model,
				values["model-url"],
				values["no-model-download"] !== true,
			);
			const mix = parseNumberFlag(values.mix, "--mix", { min: 0, max: 1 }) ?? 0.82;
			return {
				engine: "ffmpeg",
				label: "ffmpeg-voice",
				ffmpegFilter: filterString([
					"highpass=f=70",
					"lowpass=f=9500",
					`arnndn=model=${escapeFilterValue(model.path)}:mix=${mix.toFixed(2)}`,
					"speechnorm=e=6.5:r=0.0001:l=1",
					"loudnorm=I=-16:LRA=7:TP=-1.5",
				]),
				arnndn: {
					modelPath: model.path,
					modelDownloaded: model.downloaded,
					modelSource: model.source,
					mix,
				},
			};
		}
		case "strong":
		case "broadcast":
		case "ultra": {
			const model = await ensureArnndnModel(
				values.model,
				values["model-url"],
				values["no-model-download"] !== true,
			);
			const mix =
				parseNumberFlag(values.mix, "--mix", { min: 0, max: 1 }) ??
				(preset === "ultra" ? 1 : 0.95);
			return {
				engine: "ffmpeg",
				label: preset === "ultra" ? "ffmpeg-ultra" : "ffmpeg-broadcast",
				ffmpegFilter: filterString([
					preset === "ultra" ? "highpass=f=100" : "highpass=f=85",
					preset === "ultra" ? "lowpass=f=7200" : "lowpass=f=8000",
					`arnndn=model=${escapeFilterValue(model.path)}:mix=${mix.toFixed(2)}`,
					preset === "ultra"
						? "agate=threshold=0.02:ratio=6:attack=2:release=320:range=0.03:makeup=1"
						: "agate=threshold=0.012:ratio=1.8:attack=5:release=250:range=0.2:makeup=1",
					preset === "ultra"
						? "acompressor=threshold=0.09:ratio=3:attack=2:release=120:makeup=1"
						: "speechnorm=e=8:r=0.00008:l=1",
					preset === "ultra"
						? "speechnorm=e=4.5:r=0.00008:l=1"
						: "loudnorm=I=-16:LRA=6:TP=-1.5",
					preset === "ultra" ? "loudnorm=I=-16:LRA=4:TP=-1.5" : undefined,
				].filter((segment): segment is string => Boolean(segment)),
				),
				arnndn: {
					modelPath: model.path,
					modelDownloaded: model.downloaded,
					modelSource: model.source,
					mix,
				},
			};
		}
		default:
			throw new Error(
				`invalid --preset "${preset}" (expected light, voice, neural, strong, broadcast, or ultra)`,
			);
	}
}

async function buildDeepFilterPlan(preset: string): Promise<AudioPlan> {
	const binary = await ensureDeepFilterBinary(
		values["deep-filter-bin"],
		values["deep-filter-version"],
		values["no-binary-download"] !== true,
	);
	const attenOverride = parseNumberFlag(values["atten-lim-db"], "--atten-lim-db", {
		min: 0,
		max: 100,
	});
	const betaOverride = parseNumberFlag(values["pf-beta"], "--pf-beta", {
		min: 0,
		max: 1,
	});
	const arnndnModel =
		preset === "ultra"
			? await ensureArnndnModel(
					values.model,
					values["model-url"],
					values["no-model-download"] !== true,
				)
			: null;
	switch (preset) {
		case "light":
		case "voice":
		case "neural":
			return {
				engine: "deepfilter",
				label: "deepfilter-voice",
				postEncodeFilter: filterString([
					"highpass=f=70",
					"lowpass=f=9500",
					"loudnorm=I=-16:LRA=7:TP=-1.5",
				]),
				deepfilter: {
					binaryPath: binary.path,
					binaryDownloaded: binary.downloaded,
					binarySource: binary.source,
					attenLimDb: attenOverride ?? 20,
					postFilter: values["post-filter"] === true,
					...(typeof betaOverride === "number"
						? { postFilterBeta: betaOverride }
						: {}),
				},
			};
		case "strong":
			return {
				engine: "deepfilter",
				label: "deepfilter-strong",
				postEncodeFilter: filterString([
					"highpass=f=75",
					"lowpass=f=9000",
					"speechnorm=e=5.5:r=0.00015:l=1",
					"loudnorm=I=-16:LRA=6:TP=-1.5",
				]),
				deepfilter: {
					binaryPath: binary.path,
					binaryDownloaded: binary.downloaded,
					binarySource: binary.source,
					attenLimDb: attenOverride ?? 28,
					postFilter: values["post-filter"] === true || betaOverride !== undefined,
					postFilterBeta: betaOverride ?? 0.02,
				},
			};
		case "broadcast":
			return {
				engine: "deepfilter",
				label: "deepfilter-broadcast",
				postEncodeFilter: filterString([
					"highpass=f=80",
					"lowpass=f=8500",
					"agate=threshold=0.008:ratio=1.4:attack=5:release=180:range=0.35:makeup=1",
					"speechnorm=e=6:r=0.00012:l=1",
					"loudnorm=I=-16:LRA=5:TP=-1.5",
				]),
				deepfilter: {
					binaryPath: binary.path,
					binaryDownloaded: binary.downloaded,
					binarySource: binary.source,
					attenLimDb: attenOverride ?? 35,
					postFilter: true,
					postFilterBeta: betaOverride ?? 0.03,
				},
			};
		case "ultra":
			return {
				engine: "deepfilter",
				label: "deepfilter-ultra",
				postEncodeFilter: filterString([
					"highpass=f=100",
					"lowpass=f=7200",
					`arnndn=model=${escapeFilterValue(arnndnModel!.path)}:mix=1.00`,
					"agate=threshold=0.02:ratio=6:attack=2:release=320:range=0.03:makeup=1",
					"acompressor=threshold=0.09:ratio=3:attack=2:release=120:makeup=1",
					"speechnorm=e=4.5:r=0.00008:l=1",
					"loudnorm=I=-16:LRA=4:TP=-1.5",
				]),
				deepfilter: {
					binaryPath: binary.path,
					binaryDownloaded: binary.downloaded,
					binarySource: binary.source,
					attenLimDb: attenOverride ?? 85,
					postFilter: true,
					postFilterBeta: betaOverride ?? 0.18,
				},
				arnndn: {
					modelPath: arnndnModel!.path,
					modelDownloaded: arnndnModel!.downloaded,
					modelSource: arnndnModel!.source,
					mix: 1,
				},
			};
		default:
			throw new Error(
				`invalid --preset "${preset}" (expected light, voice, neural, strong, broadcast, or ultra)`,
			);
	}
}

async function buildPrimaryPlan(): Promise<AudioPlan> {
	const preset = String(values.preset ?? "voice");
	const engine = resolveEngine(values.engine, preset);
	if (engine === "ffmpeg") return await buildFfmpegPlan(preset);
	if (engine === "deepfilter") return await buildDeepFilterPlan(preset);
	if (preset === "light") return await buildFfmpegPlan(preset);
	return await buildDeepFilterPlan(preset);
}

async function runFfmpegAudio(
	inputPath: string,
	outputPath: string,
	filter: string,
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
		filter,
		...codecArgs,
		outputPath,
	]);
}

async function runDeepFilterAudio(
	inputPath: string,
	outputPath: string,
	plan: AudioPlan,
): Promise<void> {
	if (!plan.deepfilter) {
		throw new Error("internal error: missing deepfilter plan");
	}
	const tempDir = await mkdtemp(join(tmpdir(), "agentic-cap-editor-df-"));
	try {
		const inputWav = join(tempDir, "input.wav");
		const enhancedDir = join(tempDir, "enhanced");
		const enhancedWav = join(enhancedDir, "input.wav");
		await mkdir(enhancedDir, { recursive: true });
		await runCommand("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-vn",
			"-ar",
			"48000",
			"-ac",
			"1",
			inputWav,
		]);
		const args = [
			"-o",
			enhancedDir,
			"-a",
			String(plan.deepfilter.attenLimDb),
		];
		if (plan.deepfilter.postFilter) {
			args.push("--pf");
			if (typeof plan.deepfilter.postFilterBeta === "number") {
				args.push("--pf-beta", String(plan.deepfilter.postFilterBeta));
			}
		}
		args.push(inputWav);
		await runCommand(plan.deepfilter.binaryPath, args);
		const ext = extname(outputPath);
		const codecArgs = ffmpegArgsForExtension(ext);
		const ffmpegArgs = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			enhancedWav,
			"-vn",
		];
		if (plan.postEncodeFilter) {
			ffmpegArgs.push("-af", plan.postEncodeFilter);
		}
		ffmpegArgs.push(...codecArgs, outputPath);
		await runCommand("ffmpeg", ffmpegArgs);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

function planForTrack(primary: AudioPlan, kind: AudioKind): AudioPlan {
	if (kind === "mic") return primary;
	return {
		engine: "ffmpeg",
		label: "ffmpeg-system-light",
		ffmpegFilter: filterString([
			"highpass=f=40",
			"lowpass=f=12000",
			"loudnorm=I=-16:LRA=9:TP=-1.5",
		]),
	};
}

const outPath =
	values["in-place"] === true
		? capPath
		: resolve(typeof values.out === "string" ? values.out : defaultOutPath(capPath));

if (values["in-place"] && typeof values.out === "string") {
	console.error("error: use either --in-place or --out, not both");
	process.exit(2);
}

await closeCapApp();

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);
const primaryPlan = await buildPrimaryPlan();
const previewTargets = collectTargets(
	recordings,
	values["include-system-audio"] === true,
);

if (previewTargets.size === 0) {
	console.error("error: no audio tracks found in this .cap bundle");
	process.exit(1);
}

const previewFiles: TrackPreview[] = [...previewTargets.entries()].map(([path, kind]) => ({
	path,
	kind,
	engine: planForTrack(primaryPlan, kind).engine,
}));

if (values["dry-run"]) {
	console.log(
		JSON.stringify(
			{
				input: capPath,
				output: outPath,
				inPlace: values["in-place"] === true,
				preset: values.preset ?? "voice",
				engine: primaryPlan.engine,
				plan: primaryPlan,
				files: previewFiles,
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

for (const [audioPath, kind] of targets) {
	const trackPlan = planForTrack(primaryPlan, kind);
	const tempPath = `${audioPath}.sanitized${extname(audioPath)}`;
	if (values["in-place"]) {
		await copyFile(audioPath, `${audioPath}.${timestamp()}.bak`);
	}
	await mkdir(dirname(audioPath), { recursive: true });
	console.log(`sanitizing ${kind} audio (${trackPlan.label}): ${audioPath}`);
	if (trackPlan.engine === "deepfilter") {
		await runDeepFilterAudio(audioPath, tempPath, trackPlan);
	} else if (trackPlan.ffmpegFilter) {
		await runFfmpegAudio(audioPath, tempPath, trackPlan.ffmpegFilter);
	} else {
		throw new Error("internal error: ffmpeg plan missing filter");
	}
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
	engine: primaryPlan.engine,
	plan: primaryPlan,
	inPlace: values["in-place"] === true,
	includeSystemAudio: values["include-system-audio"] === true,
	fileCount: targets.size,
	files: [...targets.entries()].map(([path, kind]) => ({
		path,
		kind,
		engine: planForTrack(primaryPlan, kind).engine,
		label: planForTrack(primaryPlan, kind).label,
	})),
};
await writeFile(notesPath, `${JSON.stringify(nextNotes, null, 2)}\n`);

console.log("");
console.log(`audio sanitized: ${outPath}`);
console.log(`preset: ${values.preset ?? "voice"}`);
console.log(`engine: ${primaryPlan.engine}`);
if (primaryPlan.deepfilter) {
	console.log(`deep-filter: ${primaryPlan.deepfilter.binaryPath}`);
	console.log(`atten-lim-db: ${primaryPlan.deepfilter.attenLimDb}`);
	console.log(`post-filter: ${primaryPlan.deepfilter.postFilter ? "on" : "off"}`);
}
if (primaryPlan.arnndn?.modelPath) {
	console.log(`model: ${primaryPlan.arnndn.modelPath}`);
}
if (typeof primaryPlan.arnndn?.mix === "number") {
	console.log(`mix: ${primaryPlan.arnndn.mix.toFixed(2)}`);
}
console.log(`tracks: ${targets.size}`);
if (outPath === capPath) {
	console.log("mode: in-place (per-file .bak backups created)");
} else {
	console.log("mode: copied bundle (source left untouched)");
}
