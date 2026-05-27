import { readFile } from "node:fs/promises";
import {
	ensureTimeline,
	loadBundle,
	saveBundle,
	type TimelineSegment,
} from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

interface SourceCut {
	recordingSegment: number;
	start: number;
	end: number;
	reason?: string;
}

interface OutputMap {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

const { positionals, values } = parseArgs({
	"from-json": { type: "string" },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const jsonPath = requirePositional(
	typeof values["from-json"] === "string" ? [values["from-json"]] : [],
	0,
	"source-cuts.json",
);

const cuts = JSON.parse(await readFile(jsonPath, "utf8")) as SourceCut[];

for (const [i, cut] of cuts.entries()) {
	if (!Number.isInteger(cut.recordingSegment) || cut.recordingSegment < 0) {
		throw new Error(`cut ${i} has invalid recordingSegment`);
	}
	if (!Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.end <= cut.start) {
		throw new Error(`cut ${i} must have numeric start < end`);
	}
}

const cutsByRecording = new Map<number, SourceCut[]>();
for (const cut of cuts) {
	const list = cutsByRecording.get(cut.recordingSegment) ?? [];
	list.push(cut);
	cutsByRecording.set(cut.recordingSegment, list);
}
for (const list of cutsByRecording.values()) {
	list.sort((a, b) => a.start - b.start);
	for (let i = 1; i < list.length; i += 1) {
		if (list[i]!.start < list[i - 1]!.end) {
			throw new Error(
				`overlapping cuts for recording ${list[i]!.recordingSegment}: ${list[i - 1]!.start}-${list[i - 1]!.end} and ${list[i]!.start}-${list[i]!.end}`,
			);
		}
	}
}

function subtractCuts(seg: TimelineSegment, recCuts: SourceCut[]): TimelineSegment[] {
	let pieces: TimelineSegment[] = [seg];
	for (const cut of recCuts) {
		const next: TimelineSegment[] = [];
		for (const piece of pieces) {
			const start = Math.max(piece.start, cut.start);
			const end = Math.min(piece.end, cut.end);
			if (end <= start) {
				next.push(piece);
				continue;
			}
			if (piece.start < start) {
				next.push({ ...piece, end: start });
			}
			if (end < piece.end) {
				next.push({ ...piece, start: end });
			}
		}
		pieces = next;
	}
	return pieces.filter((piece) => piece.end - piece.start > 0.001);
}

function mapTime(t: number, maps: OutputMap[]): number | null {
	const map = maps.find((m) => t >= m.oldStart && t <= m.oldEnd);
	if (!map) return null;
	return map.newStart + (t - map.oldStart);
}

function retimeTimedArray<T>(items: T[] | undefined, maps: OutputMap[]): T[] | undefined {
	if (!Array.isArray(items)) return items;
	const out: T[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") {
			out.push(item);
			continue;
		}
		const rec = item as Record<string, unknown>;
		if (typeof rec.start !== "number" || typeof rec.end !== "number") {
			out.push(item);
			continue;
		}
		for (const map of maps) {
			const start = Math.max(rec.start, map.oldStart);
			const end = Math.min(rec.end, map.oldEnd);
			if (end - start <= 0.001) continue;
			out.push({
				...(item as object),
				start: mapTime(start, maps)!,
				end: mapTime(end, maps)!,
			} as T);
		}
	}
	return mergeAdjacentTimedItems(out);
}

function mergeAdjacentTimedItems<T>(items: T[]): T[] {
	const out: T[] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (
			last &&
			item &&
			typeof last === "object" &&
			typeof item === "object" &&
			canMergeTimedItems(last as Record<string, unknown>, item as Record<string, unknown>)
		) {
			(last as Record<string, unknown>).end = (item as Record<string, unknown>).end;
			continue;
		}
		out.push(item);
	}
	return out;
}

function canMergeTimedItems(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	if (typeof a.start !== "number" || typeof a.end !== "number") return false;
	if (typeof b.start !== "number" || typeof b.end !== "number") return false;
	if (Math.abs(a.end - b.start) > 0.00001) return false;
	const aComparable = { ...a, start: 0, end: 0 };
	const bComparable = { ...b, start: 0, end: 0 };
	return JSON.stringify(aComparable) === JSON.stringify(bComparable);
}

const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);

let oldOutput = 0;
let newOutput = 0;
const newSegments: TimelineSegment[] = [];
const maps: OutputMap[] = [];

for (const seg of timeline.segments) {
	const duration = (seg.end - seg.start) / seg.timescale;
	const oldSegStart = oldOutput;
	const pieces = subtractCuts(seg, cutsByRecording.get(seg.recordingSegment) ?? []);
	for (const piece of pieces) {
		const oldPieceStart = oldSegStart + (piece.start - seg.start) / seg.timescale;
		const oldPieceEnd = oldSegStart + (piece.end - seg.start) / seg.timescale;
		const newPieceDuration = (piece.end - piece.start) / piece.timescale;
		newSegments.push(piece);
		maps.push({
			oldStart: oldPieceStart,
			oldEnd: oldPieceEnd,
			newStart: newOutput,
			newEnd: newOutput + newPieceDuration,
		});
		newOutput += newPieceDuration;
	}
	oldOutput += duration;
}

const timedKeys = [
	"zoomSegments",
	"sceneSegments",
	"captionSegments",
	"maskSegments",
	"textSegments",
	"keyboardSegments",
	"annotations",
] as const;

const preview = {
	cuts,
	oldDuration: oldOutput,
	newDuration: newOutput,
	removed: oldOutput - newOutput,
	oldSegments: timeline.segments.length,
	newSegments: newSegments.length,
};

if (values["dry-run"]) {
	console.log(JSON.stringify(preview, null, 2));
	process.exit(0);
}

timeline.segments = newSegments;
const timelineRecord = timeline as unknown as Record<string, unknown>;
for (const key of timedKeys) {
	const value = timelineRecord[key] as unknown[] | undefined;
	timelineRecord[key] = retimeTimedArray(value, maps);
}

await saveBundle(bundle, { backup: !values["no-backup"] });
console.log(
	`applied ${cuts.length} source cut(s), removed ${preview.removed.toFixed(3)}s; timeline ${preview.oldSegments} -> ${preview.newSegments} segment(s)`,
);
