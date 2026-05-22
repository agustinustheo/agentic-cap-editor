import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { isCapAppRunning } from "./cap-app.ts";

export type ZoomMode = "auto" | { manual: { x: number; y: number } };

export type GlideDirection = "none" | "left" | "right" | "up" | "down";
export type SceneMode = "default" | "cameraOnly" | "hideCamera";

export interface ZoomSegment {
	start: number;
	end: number;
	amount: number;
	mode: ZoomMode;
	glideDirection?: GlideDirection;
	glideSpeed?: number;
	instantAnimation?: boolean;
	edgeSnapRatio?: number;
}

export interface TimelineSegment {
	recordingSegment: number;
	timescale: number;
	start: number;
	end: number;
}

export interface SceneSegment {
	start: number;
	end: number;
	mode: SceneMode;
}

export interface TimelineConfiguration {
	segments: TimelineSegment[];
	zoomSegments: ZoomSegment[];
	sceneSegments?: SceneSegment[];
	maskSegments?: unknown[];
	textSegments?: unknown[];
	captionSegments?: unknown[];
	keyboardSegments?: unknown[];
}

export interface ProjectConfiguration {
	timeline?: TimelineConfiguration | null;
	[key: string]: unknown;
}

export interface RecordingMeta {
	prettyName?: string;
	platform?: "MacOS" | "Windows" | null;
	inner?: unknown;
	[key: string]: unknown;
}

export interface CapBundle {
	path: string;
	meta: RecordingMeta;
	config: ProjectConfiguration;
}

export async function loadBundle(capPath: string): Promise<CapBundle> {
	const st = await stat(capPath).catch(() => null);
	if (!st?.isDirectory()) {
		throw new Error(`Not a .cap bundle (expected a directory): ${capPath}`);
	}
	const meta = JSON.parse(
		await readFile(join(capPath, "recording-meta.json"), "utf8"),
	) as RecordingMeta;

	let config: ProjectConfiguration = {};
	try {
		config = JSON.parse(
			await readFile(join(capPath, "project-config.json"), "utf8"),
		) as ProjectConfiguration;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	return { path: capPath, meta, config };
}

export async function saveBundle(
	bundle: CapBundle,
	{ backup = true }: { backup?: boolean } = {},
): Promise<void> {
	if (await isCapAppRunning()) {
		console.error(
			"warning: Cap.app appears to be running. Quit Cap before mutating a bundle, or it may overwrite project-config.json with stale in-memory state.",
		);
	}
	const configPath = join(bundle.path, "project-config.json");
	if (backup) {
		const exists = await stat(configPath).then(
			() => true,
			() => false,
		);
		if (exists) {
			const stamp = new Date()
				.toISOString()
				.replace(/[:.]/g, "-")
				.replace(/T/, "_")
				.slice(0, -5);
			await copyFile(configPath, `${configPath}.${stamp}.bak`);
		}
	}
	await writeFile(configPath, `${JSON.stringify(bundle.config, null, 2)}\n`);
}

export function ensureTimeline(
	config: ProjectConfiguration,
): TimelineConfiguration {
	if (!config.timeline) {
		config.timeline = { segments: [], zoomSegments: [] };
	}
	const t = config.timeline;
	t.segments ??= [];
	t.zoomSegments ??= [];
	t.sceneSegments ??= [];
	return t;
}

export async function ffprobeDuration(path: string): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const proc = spawn("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			path,
		]);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (b) => {
			stdout += b.toString();
		});
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(
					new Error(
						"ffprobe not found in PATH. Install ffmpeg (brew install ffmpeg) or pass --duration explicitly.",
					),
				);
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
				return;
			}
			const n = Number(stdout.trim());
			if (!Number.isFinite(n)) {
				reject(new Error(`Could not parse duration from ffprobe: ${stdout}`));
				return;
			}
			resolve(n);
		});
	});
}

export function primaryVideoPath(bundle: CapBundle): string {
	const meta = bundle.meta as Record<string, unknown>;
	if (Array.isArray(meta.segments)) {
		const first = meta.segments[0] as { display?: { path?: string } } | undefined;
		if (first?.display?.path) {
			return join(bundle.path, first.display.path);
		}
	}
	if (meta.display && typeof meta.display === "object") {
		const display = meta.display as { path?: string };
		if (display.path) return join(bundle.path, display.path);
	}
	return join(bundle.path, "content/output.mp4");
}

export function bundleName(capPath: string): string {
	return basename(capPath).replace(/\.cap$/, "");
}

export function recordingOffsets(durations: number[]): number[] {
	const offsets: number[] = [];
	let cum = 0;
	for (const d of durations) {
		offsets.push(cum);
		cum += d;
	}
	return offsets;
}

export function totalDuration(durations: number[]): number {
	return durations.reduce((a, b) => a + b, 0);
}

export function isInstantRecording(bundle: CapBundle): boolean {
	const meta = bundle.meta as Record<string, unknown>;
	if (Array.isArray(meta.segments)) return false;
	if (meta.display && typeof meta.display === "object") return false;
	return true;
}
