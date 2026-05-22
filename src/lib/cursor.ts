import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { CapBundle } from "./cap.ts";

export interface CursorMoveEvent {
	active_modifiers: string[];
	cursor_id: string;
	time_ms: number;
	x: number;
	y: number;
}

export interface CursorClickEvent {
	active_modifiers: string[];
	cursor_num: number;
	cursor_id: string;
	time_ms: number;
	x?: number;
	y?: number;
	down: boolean;
}

export interface CursorEvents {
	clicks: CursorClickEvent[];
	moves: CursorMoveEvent[];
}

export interface RecordingSegmentPaths {
	recordingSegment: number;
	displayPath: string;
	cameraPath?: string;
	audioPath?: string;
	systemAudioPath?: string;
	cursorPath?: string;
}

interface StudioSingleInner {
	display: { path: string };
	camera?: { path: string };
	audio?: { path: string };
	cursor?: string;
}

interface StudioMultiSegment {
	display: { path: string };
	camera?: { path: string };
	mic?: { path: string };
	systemAudio?: { path: string };
	cursor?: string;
}

interface StudioMultiInner {
	segments: StudioMultiSegment[];
}

export function recordingSegmentPaths(bundle: CapBundle): RecordingSegmentPaths[] {
	const meta = bundle.meta as Record<string, unknown>;

	if (Array.isArray(meta.segments)) {
		return (meta.segments as StudioMultiSegment[]).map((s, i) => {
			const out: RecordingSegmentPaths = {
				recordingSegment: i,
				displayPath: join(bundle.path, s.display.path),
			};
			if (s.camera?.path) out.cameraPath = join(bundle.path, s.camera.path);
			if (s.mic?.path) out.audioPath = join(bundle.path, s.mic.path);
			if (s.systemAudio?.path) out.systemAudioPath = join(bundle.path, s.systemAudio.path);
			if (typeof s.cursor === "string") out.cursorPath = join(bundle.path, s.cursor);
			return out;
		});
	}

	if (meta.display && typeof meta.display === "object") {
		const s = meta as unknown as StudioSingleInner;
		const out: RecordingSegmentPaths = {
			recordingSegment: 0,
			displayPath: join(bundle.path, s.display.path),
		};
		if (s.camera?.path) out.cameraPath = join(bundle.path, s.camera.path);
		if (s.audio?.path) out.audioPath = join(bundle.path, s.audio.path);
		if (typeof s.cursor === "string") out.cursorPath = join(bundle.path, s.cursor);
		return [out];
	}

	return [
		{
			recordingSegment: 0,
			displayPath: join(bundle.path, "content/output.mp4"),
		},
	];
}

export async function loadCursorEvents(path: string): Promise<CursorEvents | null> {
	try {
		await access(path);
	} catch {
		return null;
	}
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as CursorEvents;
	parsed.clicks ??= [];
	parsed.moves ??= [];
	parsed.clicks.sort((a, b) => a.time_ms - b.time_ms);
	parsed.moves.sort((a, b) => a.time_ms - b.time_ms);
	return parsed;
}

export function cursorPositionAt(events: CursorEvents, timeMs: number): { x: number; y: number } | null {
	if (events.moves.length === 0) return null;
	if (timeMs <= events.moves[0]!.time_ms) {
		const m = events.moves[0]!;
		return { x: m.x, y: m.y };
	}
	const last = events.moves[events.moves.length - 1]!;
	if (timeMs >= last.time_ms) return { x: last.x, y: last.y };
	let lo = 0;
	let hi = events.moves.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (events.moves[mid]!.time_ms <= timeMs) lo = mid;
		else hi = mid;
	}
	const a = events.moves[lo]!;
	const b = events.moves[hi]!;
	const t = (timeMs - a.time_ms) / Math.max(1e-6, b.time_ms - a.time_ms);
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
