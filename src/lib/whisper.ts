import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat, access } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";

export interface TranscriptSegment {
	startSec: number;
	endSec: number;
	text: string;
}

export interface Transcript {
	source: string;
	model: string;
	generatedAt: string;
	segments: TranscriptSegment[];
}

export interface TranscribeOptions {
	audioPath: string;
	cacheDir: string;
	modelPath?: string | undefined;
	whisperBin?: string | undefined;
	language?: string | undefined;
	maxSegmentLen?: number | undefined;
	refresh?: boolean | undefined;
}

const DEFAULT_MODEL_SEARCH_PATHS = [
	process.env.WHISPER_MODEL ?? "",
	join(homedir(), ".cache/whisper/ggml-base.en.bin"),
	join(homedir(), "whisper.cpp/models/ggml-base.en.bin"),
	"/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
	"/usr/local/share/whisper-cpp/ggml-base.en.bin",
].filter((p) => p.length > 0);

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveModelPath(explicit?: string): Promise<string> {
	if (explicit) {
		if (!(await pathExists(explicit))) {
			throw new Error(`whisper model not found at ${explicit}`);
		}
		return explicit;
	}
	for (const candidate of DEFAULT_MODEL_SEARCH_PATHS) {
		if (await pathExists(candidate)) return candidate;
	}
	throw new Error(
		[
			"No whisper model found. Either:",
			"  1) pass --model /path/to/ggml-base.en.bin",
			"  2) set WHISPER_MODEL env var",
			"  3) download a model to ~/.cache/whisper/ggml-base.en.bin",
			"",
			"Download a model:",
			"  mkdir -p ~/.cache/whisper && \\",
			"  curl -L -o ~/.cache/whisper/ggml-base.en.bin \\",
			"    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
		].join("\n"),
	);
}

async function resolveWhisperBin(explicit?: string): Promise<string> {
	const candidates = [
		explicit,
		process.env.WHISPER_BIN,
		"whisper-cli",
		"whisper-cpp",
	].filter((v): v is string => typeof v === "string" && v.length > 0);
	for (const c of candidates) {
		const exists = await new Promise<boolean>((resolve) => {
			const proc = spawn(c, ["--help"], { stdio: "ignore" });
			proc.on("error", () => resolve(false));
			proc.on("close", () => resolve(true));
		});
		if (exists) return c;
	}
	throw new Error(
		"whisper binary not found. Install: `brew install whisper-cpp` (provides `whisper-cli`).",
	);
}

async function ffmpegToWav16k(inputPath: string, outputPath: string): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });
	await new Promise<void>((resolve, reject) => {
		const proc = spawn("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-ar",
			"16000",
			"-ac",
			"1",
			"-c:a",
			"pcm_s16le",
			outputPath,
		]);
		let stderr = "";
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg → wav exited ${code}: ${stderr.trim()}`));
		});
	});
}

interface WhisperCliSegment {
	offsets?: { from: number; to: number };
	timestamps?: { from: string; to: string };
	text: string;
}

interface WhisperCliOutput {
	transcription: WhisperCliSegment[];
}

function timestampToSeconds(ts: string): number {
	const m = ts.match(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/);
	if (!m) return Number.NaN;
	return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

async function runWhisperCli(
	whisperBin: string,
	modelPath: string,
	wavPath: string,
	outputBase: string,
	maxSegmentLen?: number,
	language?: string,
): Promise<WhisperCliOutput> {
	const args = ["-m", modelPath, "-f", wavPath, "-of", outputBase, "-oj", "--no-prints"];
	if (typeof maxSegmentLen === "number") {
		args.push("-ml", String(maxSegmentLen));
	}
	if (language) {
		args.push("-l", language);
	}
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(whisperBin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${whisperBin} exited ${code}: ${stderr.trim()}`));
		});
	});
	const raw = await readFile(`${outputBase}.json`, "utf8");
	return JSON.parse(raw) as WhisperCliOutput;
}

function parseWhisperOutput(out: WhisperCliOutput): TranscriptSegment[] {
	const result: TranscriptSegment[] = [];
	for (const seg of out.transcription) {
		let startSec: number;
		let endSec: number;
		if (seg.offsets) {
			startSec = seg.offsets.from / 1000;
			endSec = seg.offsets.to / 1000;
		} else if (seg.timestamps) {
			startSec = timestampToSeconds(seg.timestamps.from);
			endSec = timestampToSeconds(seg.timestamps.to);
		} else {
			continue;
		}
		const text = seg.text.trim();
		if (!text) continue;
		result.push({ startSec, endSec, text });
	}
	return result;
}

async function cacheKey(audioPath: string, modelPath: string, maxLen: number | undefined): Promise<string> {
	const st = await stat(audioPath);
	const data = `${audioPath}|${st.mtimeMs}|${st.size}|${basename(modelPath)}|ml=${maxLen ?? "-"}`;
	return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export async function transcribe(opts: TranscribeOptions): Promise<Transcript> {
	const modelPath = await resolveModelPath(opts.modelPath);
	const whisperBin = await resolveWhisperBin(opts.whisperBin);
	const key = await cacheKey(opts.audioPath, modelPath, opts.maxSegmentLen);
	const cachePath = join(opts.cacheDir, `transcript-${key}.json`);

	if (!opts.refresh && (await pathExists(cachePath))) {
		const cached = JSON.parse(await readFile(cachePath, "utf8")) as Transcript;
		return cached;
	}

	const tmpBase = join(tmpdir(), `cap-whisper-${key}`);
	const wavPath = `${tmpBase}.wav`;
	const outBase = tmpBase;

	await ffmpegToWav16k(opts.audioPath, wavPath);
	const cliOut = await runWhisperCli(
		whisperBin,
		modelPath,
		wavPath,
		outBase,
		opts.maxSegmentLen,
		opts.language,
	);
	const segments = parseWhisperOutput(cliOut);

	const transcript: Transcript = {
		source: resolve(opts.audioPath),
		model: basename(modelPath),
		generatedAt: new Date().toISOString(),
		segments,
	};
	await mkdir(opts.cacheDir, { recursive: true });
	await writeFile(cachePath, `${JSON.stringify(transcript, null, 2)}\n`);
	return transcript;
}

export function transcriptGaps(
	segments: TranscriptSegment[],
	minGapSec: number,
): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	for (let i = 0; i < segments.length - 1; i++) {
		const a = segments[i]!;
		const b = segments[i + 1]!;
		if (b.startSec - a.endSec >= minGapSec) {
			out.push({ start: a.endSec, end: b.startSec });
		}
	}
	return out;
}
