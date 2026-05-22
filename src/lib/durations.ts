import type { CapBundle } from "./cap.ts";
import { ffprobeDuration } from "./cap.ts";
import { recordingSegmentPaths, type RecordingSegmentPaths } from "./cursor.ts";

export interface RecordingSegmentDuration {
	recordingSegment: number;
	duration: number;
	components: {
		display?: number;
		camera?: number;
		audio?: number;
		systemAudio?: number;
	};
}

async function probeOptional(path: string | undefined): Promise<number | undefined> {
	if (!path) return undefined;
	return ffprobeDuration(path);
}

export async function recordingDurationLikeCap(
	rec: RecordingSegmentPaths,
): Promise<RecordingSegmentDuration> {
	const components: RecordingSegmentDuration["components"] = {};
	const display = await probeOptional(rec.displayPath);
	if (display !== undefined) components.display = display;
	const camera = await probeOptional(rec.cameraPath);
	if (camera !== undefined) components.camera = camera;
	const audio = await probeOptional(rec.audioPath);
	if (audio !== undefined) components.audio = audio;
	const systemAudio = await probeOptional(rec.systemAudioPath);
	if (systemAudio !== undefined) components.systemAudio = systemAudio;
	const durations = Object.values(components).filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
	if (durations.length === 0) {
		throw new Error(`Could not read any media duration for recording ${rec.recordingSegment}`);
	}
	return {
		recordingSegment: rec.recordingSegment,
		duration: Math.max(...durations),
		components,
	};
}

export async function recordingDurationsLikeCap(
	bundle: CapBundle,
): Promise<RecordingSegmentDuration[]> {
	const recordings = recordingSegmentPaths(bundle);
	const out: RecordingSegmentDuration[] = [];
	for (const rec of recordings) {
		out.push(await recordingDurationLikeCap(rec));
	}
	return out;
}

export function rawRecordingDurationLikeCap(
	segments: RecordingSegmentDuration[],
): number {
	return segments.reduce((sum, segment) => sum + segment.duration, 0);
}
