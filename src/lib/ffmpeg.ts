import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SilenceRange {
	start: number;
	end: number;
	duration: number;
}

export interface SilenceDetectOptions {
	noiseDb?: number;
	minDurationSec?: number;
}

export async function detectSilences(
	inputPath: string,
	{ noiseDb = -30, minDurationSec = 0.4 }: SilenceDetectOptions = {},
): Promise<SilenceRange[]> {
	const filter = `silencedetect=noise=${noiseDb}dB:d=${minDurationSec}`;
	const args = ["-hide_banner", "-nostats", "-i", inputPath, "-af", filter, "-f", "null", "-"];
	const stderr = await runFfmpegCollectingStderr(args);
	return parseSilenceLines(stderr);
}

export function parseSilenceLines(stderr: string): SilenceRange[] {
	const ranges: SilenceRange[] = [];
	let pendingStart: number | null = null;
	for (const line of stderr.split("\n")) {
		const startMatch = line.match(/silence_start:\s*(-?[0-9.]+)/);
		if (startMatch) {
			pendingStart = Number(startMatch[1]);
			continue;
		}
		const endMatch = line.match(
			/silence_end:\s*(-?[0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/,
		);
		if (endMatch && pendingStart !== null) {
			const end = Number(endMatch[1]);
			const duration = Number(endMatch[2]);
			ranges.push({ start: Math.max(0, pendingStart), end, duration });
			pendingStart = null;
		}
	}
	return ranges;
}

export interface ExtractFrameOptions {
	at: number;
	outPath: string;
}

export async function extractFrame(inputPath: string, opts: ExtractFrameOptions): Promise<void> {
	await mkdir(dirname(opts.outPath), { recursive: true });
	const args = [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		"-ss",
		String(opts.at),
		"-i",
		inputPath,
		"-frames:v",
		"1",
		"-update",
		"1",
		"-y",
		opts.outPath,
	];
	await runFfmpeg(args);
}

function runFfmpeg(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn("ffmpeg", args);
		let stderr = "";
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("ffmpeg not found in PATH. Install: brew install ffmpeg"));
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
		});
	});
}

function runFfmpegCollectingStderr(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("ffmpeg", args);
		let stderr = "";
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("ffmpeg not found in PATH. Install: brew install ffmpeg"));
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			if (code === 0 || code === null) resolve(stderr);
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
		});
	});
}
