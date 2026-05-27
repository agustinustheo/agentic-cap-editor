import {
	ensureTimeline,
	loadBundle,
	saveBundle,
	type TimelineSegment,
} from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";

interface SpeedOverride {
	index: number;
	timescale: number;
}

interface SegmentMap {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

const EPSILON = 0.000001;

const { positionals, values } = parseArgs({
	set: { type: "string" },
	"zero-based": { type: "boolean", default: false },
	"dry-run": { type: "boolean", default: false },
	"no-backup": { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");

if (typeof values.set !== "string" || !values.set.trim()) {
	console.error(
		'error: provide --set "1:1.5,2:2" (segment indexes are 1-based by default; add --zero-based to use inspect indexes)',
	);
	process.exit(2);
}

function parseSetSpec(spec: string, zeroBased: boolean): SpeedOverride[] {
	const overrides: SpeedOverride[] = [];
	for (const token of spec.split(",")) {
		const trimmed = token.trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^(\d+)\s*[:=]\s*([0-9.]+)$/);
		if (!match) {
			console.error(`error: bad --set token "${trimmed}" — expected "index:speed"`);
			process.exit(2);
		}
		const rawIndex = Number(match[1]);
		const timescale = Number(match[2]);
		if (!Number.isFinite(timescale) || timescale <= 0) {
			console.error(`error: speed for "${trimmed}" must be > 0`);
			process.exit(2);
		}
		const index = zeroBased ? rawIndex : rawIndex - 1;
		if (!Number.isInteger(index) || index < 0) {
			console.error(`error: segment index "${match[1]}" is invalid`);
			process.exit(2);
		}
		overrides.push({ index, timescale });
	}
	return overrides;
}

function segmentDuration(segment: TimelineSegment): number {
	return (segment.end - segment.start) / segment.timescale;
}

function mapTimeWithinSegment(time: number, map: SegmentMap): number {
	const span = map.oldEnd - map.oldStart;
	if (span <= EPSILON) return map.newStart;
	const ratio = (time - map.oldStart) / span;
	return map.newStart + ratio * (map.newEnd - map.newStart);
}

function overlaps(map: SegmentMap, start: number, end: number): boolean {
	return start < map.oldEnd - EPSILON && end > map.oldStart + EPSILON;
}

function retimeKeyboardKeys(
	keys: unknown[],
	itemStart: number,
	pieceStart: number,
	pieceEnd: number,
	pieceNewStart: number,
	map: SegmentMap,
	isLastPiece: boolean,
): unknown[] {
	const retimed: unknown[] = [];
	for (const keyEntry of keys) {
		if (!keyEntry || typeof keyEntry !== "object") {
			retimed.push(keyEntry);
			continue;
		}
		const keyRecord = keyEntry as Record<string, unknown>;
		if (typeof keyRecord.timeOffset !== "number") {
			retimed.push(keyEntry);
			continue;
		}
		const absoluteTime = itemStart + keyRecord.timeOffset / 1000;
		const inPiece =
			absoluteTime >= pieceStart - EPSILON &&
			(absoluteTime < pieceEnd - EPSILON || (isLastPiece && absoluteTime <= pieceEnd + EPSILON));
		if (!inPiece) continue;
		retimed.push({
			...keyRecord,
			timeOffset: (mapTimeWithinSegment(absoluteTime, map) - pieceNewStart) * 1000,
		});
	}
	return retimed;
}

function retimeTimedArray(items: unknown[] | undefined, maps: SegmentMap[]): unknown[] | undefined {
	if (!Array.isArray(items)) return items;
	const out: unknown[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") {
			out.push(item);
			continue;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.start !== "number" || typeof record.end !== "number") {
			out.push(item);
			continue;
		}

		const pieceMaps = maps.filter((map) => overlaps(map, record.start as number, record.end as number));
		for (const [pieceIndex, map] of pieceMaps.entries()) {
			const pieceStart = Math.max(record.start as number, map.oldStart);
			const pieceEnd = Math.min(record.end as number, map.oldEnd);
			if (pieceEnd - pieceStart <= EPSILON) continue;
			const newItem = structuredClone(record);
			newItem.start = mapTimeWithinSegment(pieceStart, map);
			newItem.end = mapTimeWithinSegment(pieceEnd, map);
			if (Array.isArray(record.keys)) {
				newItem.keys = retimeKeyboardKeys(
					record.keys,
					record.start as number,
					pieceStart,
					pieceEnd,
					newItem.start as number,
					map,
					pieceIndex === pieceMaps.length - 1,
				);
			}
			out.push(newItem);
		}
	}
	return out;
}

const overrides = parseSetSpec(values.set, values["zero-based"] === true);
const bundle = await loadBundle(capPath);
const timeline = ensureTimeline(bundle.config);

if (timeline.segments.length === 0) {
	throw new Error("timeline has no segments to speed up");
}

const overrideMap = new Map<number, number>();
for (const override of overrides) {
	if (override.index >= timeline.segments.length) {
		throw new Error(
			`segment ${values["zero-based"] === true ? override.index : override.index + 1} is out of range for timeline with ${timeline.segments.length} segment(s)`,
		);
	}
	overrideMap.set(override.index, override.timescale);
}

const oldSegments = timeline.segments.map((segment) => ({ ...segment }));
const newSegments = timeline.segments.map((segment, index) => ({
	...segment,
	timescale: overrideMap.get(index) ?? segment.timescale,
}));

let oldOutput = 0;
let newOutput = 0;
const maps: SegmentMap[] = [];

for (let index = 0; index < oldSegments.length; index += 1) {
	const oldSegment = oldSegments[index]!;
	const newSegment = newSegments[index]!;
	const oldDuration = segmentDuration(oldSegment);
	const newDuration = segmentDuration(newSegment);
	maps.push({
		oldStart: oldOutput,
		oldEnd: oldOutput + oldDuration,
		newStart: newOutput,
		newEnd: newOutput + newDuration,
	});
	oldOutput += oldDuration;
	newOutput += newDuration;
}

const timedKeys = [
	"zoomSegments",
	"sceneSegments",
	"captionSegments",
	"maskSegments",
	"textSegments",
	"keyboardSegments",
];

const preview = {
	oldDuration: oldOutput,
	newDuration: newOutput,
	segments: newSegments.map((segment, index) => ({
		index,
		recordingSegment: segment.recordingSegment,
		start: segment.start,
		end: segment.end,
		timescale: segment.timescale,
		outputDuration: segmentDuration(segment),
	})),
};

if (values["dry-run"]) {
	console.log(JSON.stringify(preview, null, 2));
	process.exit(0);
}

timeline.segments = newSegments;
const timelineRecord = timeline as unknown as Record<string, unknown>;
for (const key of timedKeys) {
	timelineRecord[key] = retimeTimedArray(timelineRecord[key] as unknown[] | undefined, maps);
}

await saveBundle(bundle, { backup: !values["no-backup"] });
console.log(
	`updated ${overrideMap.size} segment speed(s); duration ${oldOutput.toFixed(3)}s -> ${newOutput.toFixed(3)}s`,
);
