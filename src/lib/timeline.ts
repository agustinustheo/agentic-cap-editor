import type { TimelineSegment } from "./cap.ts";

export interface CutRange {
	start: number;
	end: number;
}

export function timelineDuration(segments: TimelineSegment[]): number {
	let total = 0;
	for (const s of segments) {
		const dur = (s.end - s.start) / s.timescale;
		total += dur;
	}
	return total;
}

export function applyCut(
	segments: TimelineSegment[],
	cut: CutRange,
): TimelineSegment[] {
	if (cut.end <= cut.start) {
		throw new Error(
			`Cut end (${cut.end}) must be greater than start (${cut.start})`,
		);
	}
	const out: TimelineSegment[] = [];
	let accum = 0;
	for (const seg of segments) {
		const dur = (seg.end - seg.start) / seg.timescale;
		const outStart = accum;
		const outEnd = accum + dur;
		accum = outEnd;

		if (cut.end <= outStart || cut.start >= outEnd) {
			out.push(seg);
			continue;
		}
		if (cut.start <= outStart && cut.end >= outEnd) {
			continue;
		}
		if (cut.start > outStart) {
			out.push({
				recordingSegment: seg.recordingSegment,
				timescale: seg.timescale,
				start: seg.start,
				end: seg.start + (cut.start - outStart) * seg.timescale,
			});
		}
		if (cut.end < outEnd) {
			out.push({
				recordingSegment: seg.recordingSegment,
				timescale: seg.timescale,
				start: seg.start + (cut.end - outStart) * seg.timescale,
				end: seg.end,
			});
		}
	}
	return out;
}
