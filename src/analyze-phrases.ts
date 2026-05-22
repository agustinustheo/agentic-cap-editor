import { join } from "node:path";
import { loadBundle, type TimelineSegment } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import { recordingSegmentPaths } from "./lib/cursor.ts";
import { transcribe } from "./lib/whisper.ts";

interface TimelineSegmentWithOffset extends TimelineSegment {
	outputStart: number;
	outputEnd: number;
}

interface PhraseFinding {
	recordingSegment: number;
	sourceStart: number;
	sourceEnd: number;
	outputStart: number | null;
	outputEnd: number | null;
	kind: string;
	text: string;
	reason: string;
}

const fillerPatterns = [
	{ label: "like", pattern: /\blike\b/g },
	{ label: "right", pattern: /\bright\b/g },
	{ label: "you know", pattern: /\byou know\b/g },
	{ label: "sort of / kind of", pattern: /\b(sort of|kind of)\b/g },
	{ label: "and yeah", pattern: /\band yeah\b/g },
	{ label: "so", pattern: /^so\b|\bso\s+so\b/g },
];

const awkwardPhrasePatterns = [
	{ label: "compare logs repeated", pattern: /compare .*logs.*compare .*logs/ },
	{ label: "try/run repeated", pattern: /\btry\b.*\b(run|running)\b.*\b(run|running)\b/ },
	{ label: "hope/sure closing hedge", pattern: /\bi hope\b.*\bi'?m sure\b/ },
	{ label: "same word repeated", pattern: /\b(\w+)\s+\1\b/ },
];

const { positionals, values } = parseArgs({
	model: { type: "string" },
	"whisper-bin": { type: "string" },
	language: { type: "string" },
	"max-segment-len": { type: "string", default: "18" },
	refresh: { type: "boolean", default: false },
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const maxSegmentLen = Number(values["max-segment-len"]);
if (!Number.isFinite(maxSegmentLen) || maxSegmentLen <= 0) {
	throw new Error("--max-segment-len must be a positive number");
}

const bundle = await loadBundle(capPath);
const recordings = recordingSegmentPaths(bundle);
const cacheDir = join(bundle.path, ".transcripts");
const timeline = addTimelineOffsets(bundle.config.timeline?.segments ?? []);
const findings: PhraseFinding[] = [];

for (const rec of recordings) {
	const source = rec.audioPath ?? rec.displayPath;
	const transcript = await transcribe({
		audioPath: source,
		cacheDir,
		modelPath: typeof values.model === "string" ? values.model : undefined,
		whisperBin: typeof values["whisper-bin"] === "string" ? values["whisper-bin"] : undefined,
		language: typeof values.language === "string" ? values.language : undefined,
		maxSegmentLen,
		refresh: values.refresh === true,
	});

	for (const seg of transcript.segments) {
		for (const finding of inspectText(rec.recordingSegment, seg.startSec, seg.endSec, seg.text)) {
			findings.push(finding);
		}
	}
}

findings.sort((a, b) => (a.outputStart ?? Number.MAX_SAFE_INTEGER) - (b.outputStart ?? Number.MAX_SAFE_INTEGER));

if (values.json) {
	console.log(JSON.stringify({ findings }, null, 2));
} else {
	if (findings.length === 0) {
		console.log("(no filler/repetition candidates found)");
	} else {
		for (const f of findings) {
			const output =
				f.outputStart === null || f.outputEnd === null
					? "omitted"
					: `${f.outputStart.toFixed(2)}-${f.outputEnd.toFixed(2)}s`;
			console.log(
				`${output} | rec=${f.recordingSegment} src=${f.sourceStart.toFixed(2)}-${f.sourceEnd.toFixed(2)} | ${f.kind}: ${f.reason}`,
			);
			console.log(`  ${f.text}`);
		}
	}
}

function inspectText(
	recordingSegment: number,
	sourceStart: number,
	sourceEnd: number,
	text: string,
): PhraseFinding[] {
	const normalized = normalize(text);
	const out: PhraseFinding[] = [];
	const fillerHits = fillerPatterns.filter((p) => p.pattern.test(normalized)).map((p) => p.label);
	if (fillerHits.length) {
		out.push(makeFinding(recordingSegment, sourceStart, sourceEnd, "filler", text, fillerHits.join(", ")));
	}

	const repeated = repeatedNgrams(normalized);
	if (repeated.length) {
		out.push(makeFinding(recordingSegment, sourceStart, sourceEnd, "repetition", text, repeated.join(", ")));
	}

	for (const phrase of awkwardPhrasePatterns) {
		if (phrase.pattern.test(normalized)) {
			out.push(makeFinding(recordingSegment, sourceStart, sourceEnd, "awkward-phrase", text, phrase.label));
		}
	}
	return out;
}

function makeFinding(
	recordingSegment: number,
	sourceStart: number,
	sourceEnd: number,
	kind: string,
	text: string,
	reason: string,
): PhraseFinding {
	const mappedStart = sourceToOutput(recordingSegment, sourceStart);
	const mappedEnd = sourceToOutput(recordingSegment, sourceEnd);
	return {
		recordingSegment,
		sourceStart,
		sourceEnd,
		outputStart: mappedStart,
		outputEnd: mappedEnd,
		kind,
		text,
		reason,
	};
}

function repeatedNgrams(text: string): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const hits = new Set<string>();
	for (let n = 1; n <= 4; n += 1) {
		for (let i = 0; i + n * 2 <= words.length; i += 1) {
			const a = words.slice(i, i + n).join(" ");
			const b = words.slice(i + n, i + n * 2).join(" ");
			if (a === b && !["the", "a", "to", "and"].includes(a)) hits.add(a);
		}
	}
	return [...hits];
}

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9'\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function addTimelineOffsets(segments: TimelineSegment[]): TimelineSegmentWithOffset[] {
	const out: TimelineSegmentWithOffset[] = [];
	let acc = 0;
	for (const s of segments) {
		const dur = (s.end - s.start) / s.timescale;
		out.push({ ...s, outputStart: acc, outputEnd: acc + dur });
		acc += dur;
	}
	return out;
}

function sourceToOutput(recordingSegment: number, sourceTime: number): number | null {
	for (const s of timeline) {
		if (s.recordingSegment !== recordingSegment) continue;
		if (sourceTime < s.start || sourceTime > s.end) continue;
		return s.outputStart + (sourceTime - s.start) / s.timescale;
	}
	return null;
}
