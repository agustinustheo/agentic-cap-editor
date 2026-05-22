import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import {
	cursorPositionAt,
	loadCursorEvents,
	recordingSegmentPaths,
	type RecordingSegmentPaths,
} from "./lib/cursor.ts";
import { extractFrame } from "./lib/ffmpeg.ts";
import { timelineDuration, type CutRange } from "./lib/timeline.ts";

interface BoundaryArtifact {
	prevIndex: number;
	nextIndex: number;
	label: string;
	outputTime: number;
	prev: SegmentSide;
	next: SegmentSide;
	cursorJump: number | null;
	contactSheet: string;
	previewMp4: string | null;
	audioWav: string | null;
	waveform: string | null;
	volumedetect: VolumeStats | null;
	silences: CutRange[];
}

interface SegmentSide {
	recordingSegment: number;
	sourceTime: number;
	cursor: { x: number; y: number } | null;
}

interface VolumeStats {
	meanDb: number | null;
	maxDb: number | null;
}

const { positionals, values } = parseArgs({
	"from-clip": { type: "string" },
	"to-clip": { type: "string" },
	window: { type: "string", default: "2" },
	out: { type: "string" },
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const windowSec = positiveNumber(String(values.window), "--window");
const bundle = await loadBundle(capPath);
const timeline = bundle.config.timeline;

if (!timeline || timeline.segments.length < 2) {
	throw new Error("This project needs at least two timeline segments to analyze transitions.");
}

const paths = recordingSegmentPaths(bundle);
const pathsBySegment = new Map(paths.map((p) => [p.recordingSegment, p]));
const outputRoot = resolve(
	String(
		values.out ??
			join(
				"/tmp",
				"agentic-cap-editor",
				"transitions",
				`${slug(basename(capPath, ".cap"))}-${timestamp()}`,
			),
	),
);

const fromClip = values["from-clip"] === undefined ? 1 : positiveInteger(String(values["from-clip"]), "--from-clip");
const toClip =
	values["to-clip"] === undefined
		? timeline.segments.length
		: positiveInteger(String(values["to-clip"]), "--to-clip");

if (fromClip < 1 || fromClip >= timeline.segments.length) {
	throw new Error(`--from-clip must be between 1 and ${timeline.segments.length - 1}`);
}
if (toClip <= fromClip || toClip > timeline.segments.length) {
	throw new Error(`--to-clip must be greater than --from-clip and <= ${timeline.segments.length}`);
}

await mkdir(outputRoot, { recursive: true });

const boundaries: BoundaryArtifact[] = [];
for (let prevIndex = fromClip - 1; prevIndex <= toClip - 2; prevIndex += 1) {
	boundaries.push(await analyzeBoundary(prevIndex));
}

const manifest = {
	capPath: bundle.path,
	outputRoot,
	windowSec,
	outputDurationSec: timelineDuration(timeline.segments),
	boundaries,
};

await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(outputRoot, "report.md"), renderReport(manifest));
await writeFile(join(outputRoot, "review.html"), renderHtml(manifest));

if (values.json) {
	console.log(JSON.stringify(manifest, null, 2));
} else {
	console.log(`transition debug artifacts: ${outputRoot}`);
	console.log("");
	for (const b of boundaries) {
		const cursor = b.cursorJump === null ? "n/a" : `${b.cursorJump.toFixed(1)}px`;
		const volume =
			b.volumedetect === null
				? "n/a"
				: `mean ${formatNullableDb(b.volumedetect.meanDb)}, max ${formatNullableDb(b.volumedetect.maxDb)}`;
		console.log(
			`${b.label} @ ${b.outputTime.toFixed(3)}s | rec ${b.prev.recordingSegment}->${b.next.recordingSegment} | cursor jump ${cursor} | audio ${volume}`,
		);
		console.log(`  frames: ${b.contactSheet}`);
		if (b.previewMp4) console.log(`  preview: ${b.previewMp4}`);
		if (b.audioWav) console.log(`  listen: ${b.audioWav}`);
		if (b.waveform) console.log(`  waveform: ${b.waveform}`);
	}
	console.log("");
	console.log(`report: ${join(outputRoot, "report.md")}`);
	console.log(`review: ${join(outputRoot, "review.html")}`);
}

async function analyzeBoundary(prevIndex: number): Promise<BoundaryArtifact> {
	const prev = timeline!.segments[prevIndex]!;
	const next = timeline!.segments[prevIndex + 1]!;
	const label = `clip-${prevIndex + 1}-to-${prevIndex + 2}`;
	const dir = join(outputRoot, label);
	await mkdir(dir, { recursive: true });

	const outputTime = timeline!.segments
		.slice(0, prevIndex + 1)
		.reduce((sum, s) => sum + (s.end - s.start) / s.timescale, 0);

	const prevPaths = requireRecordingPaths(pathsBySegment, prev.recordingSegment);
	const nextPaths = requireRecordingPaths(pathsBySegment, next.recordingSegment);
	const prevFrames = await extractBoundaryFrames(prevPaths.displayPath, prev.start, prev.end, "before", dir);
	const nextFrames = await extractBoundaryFrames(nextPaths.displayPath, next.start, next.end, "after", dir);
	const contactSheet = join(dir, "contact-sheet.png");
	await makeContactSheet([...prevFrames, ...nextFrames], contactSheet);

	const prevCursorEvents = prevPaths.cursorPath ? await loadCursorEvents(prevPaths.cursorPath) : null;
	const nextCursorEvents = nextPaths.cursorPath ? await loadCursorEvents(nextPaths.cursorPath) : null;
	const prevCursor = prevCursorEvents ? cursorPositionAt(prevCursorEvents, prev.end * 1000) : null;
	const nextCursor = nextCursorEvents ? cursorPositionAt(nextCursorEvents, next.start * 1000) : null;
	const cursorJump =
		prevCursor && nextCursor
			? Math.hypot(nextCursor.x - prevCursor.x, nextCursor.y - prevCursor.y)
			: null;

	let audioWav: string | null = null;
	let previewMp4: string | null = null;
	let waveform: string | null = null;
	let volumedetect: VolumeStats | null = null;
	let silences: CutRange[] = [];
	if (prevPaths.audioPath && nextPaths.audioPath) {
		audioWav = join(dir, "boundary-audio.wav");
		const prevStart = Math.max(prev.start, prev.end - windowSec);
		const nextEnd = Math.min(next.end, next.start + windowSec);
		await concatBoundaryAudio(prevPaths.audioPath, prevStart, prev.end, nextPaths.audioPath, next.start, nextEnd, audioWav);
		previewMp4 = join(dir, "boundary-preview.mp4");
		await makeBoundaryPreview(
			prevPaths.displayPath,
			prevPaths.audioPath,
			prevStart,
			prev.end,
			nextPaths.displayPath,
			nextPaths.audioPath,
			next.start,
			nextEnd,
			previewMp4,
		);
		waveform = join(dir, "waveform.png");
		await makeWaveform(audioWav, waveform);
		volumedetect = await detectVolume(audioWav);
		silences = await detectBoundarySilences(audioWav);
	}

	return {
		prevIndex,
		nextIndex: prevIndex + 1,
		label,
		outputTime,
		prev: {
			recordingSegment: prev.recordingSegment,
			sourceTime: prev.end,
			cursor: prevCursor,
		},
		next: {
			recordingSegment: next.recordingSegment,
			sourceTime: next.start,
			cursor: nextCursor,
		},
		cursorJump,
		contactSheet,
		previewMp4,
		audioWav,
		waveform,
		volumedetect,
		silences,
	};
}

async function extractBoundaryFrames(
	videoPath: string,
	segmentStart: number,
	segmentEnd: number,
	prefix: "before" | "after",
	dir: string,
): Promise<{ path: string; label: string }[]> {
	const offsets = prefix === "before" ? [-1, -0.25, -0.04] : [0.04, 0.25, 1];
	const out: { path: string; label: string }[] = [];
	for (const offset of offsets) {
		const sourceTime = clamp(segmentEnd + offset, segmentStart, segmentEnd);
		const afterTime = clamp(segmentStart + offset, segmentStart, segmentEnd);
		const at = prefix === "before" ? sourceTime : afterTime;
		const nameOffset = Math.abs(offset).toFixed(2).replace(".", "p");
		const framePath = join(dir, `${prefix}-${nameOffset}s.png`);
		await extractFrame(videoPath, { at, outPath: framePath });
		out.push({ path: framePath, label: `${prefix} ${Math.abs(offset).toFixed(2)}s` });
	}
	return out;
}

async function makeContactSheet(frames: { path: string; label: string }[], outPath: string): Promise<void> {
	const inputs = frames.flatMap((f) => ["-i", f.path]);
	const scaled = frames
		.map(
			(_, i) =>
				`[${i}:v]scale=360:203:force_original_aspect_ratio=decrease,pad=360:203:(ow-iw)/2:(oh-ih)/2:color=black[v${i}]`,
		)
		.join(";");
	const labels = frames.map((_, i) => `[v${i}]`).join("");
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		...inputs,
		"-filter_complex",
		`${scaled};${labels}hstack=inputs=${frames.length}[out]`,
		"-map",
		"[out]",
		"-frames:v",
		"1",
		"-y",
		outPath,
	]);
}

async function concatBoundaryAudio(
	prevAudioPath: string,
	prevStart: number,
	prevEnd: number,
	nextAudioPath: string,
	nextStart: number,
	nextEnd: number,
	outPath: string,
): Promise<void> {
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		"-i",
		prevAudioPath,
		"-i",
		nextAudioPath,
		"-filter_complex",
		`[0:a]atrim=start=${prevStart}:end=${prevEnd},asetpts=PTS-STARTPTS[a0];[1:a]atrim=start=${nextStart}:end=${nextEnd},asetpts=PTS-STARTPTS[a1];[a0][a1]concat=n=2:v=0:a=1[out]`,
		"-map",
		"[out]",
		"-ac",
		"1",
		"-ar",
		"48000",
		"-y",
		outPath,
	]);
}

async function makeBoundaryPreview(
	prevVideoPath: string,
	prevAudioPath: string,
	prevStart: number,
	prevEnd: number,
	nextVideoPath: string,
	nextAudioPath: string,
	nextStart: number,
	nextEnd: number,
	outPath: string,
): Promise<void> {
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		"-i",
		prevVideoPath,
		"-i",
		prevAudioPath,
		"-i",
		nextVideoPath,
		"-i",
		nextAudioPath,
		"-filter_complex",
		`[0:v]trim=start=${prevStart}:end=${prevEnd},setpts=PTS-STARTPTS,scale=1280:-2,setsar=1[v0];[1:a]atrim=start=${prevStart}:end=${prevEnd},asetpts=PTS-STARTPTS[a0];[2:v]trim=start=${nextStart}:end=${nextEnd},setpts=PTS-STARTPTS,scale=1280:-2,setsar=1[v1];[3:a]atrim=start=${nextStart}:end=${nextEnd},asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
		"-map",
		"[v]",
		"-map",
		"[a]",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"20",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-y",
		outPath,
	]);
}

async function makeWaveform(inputPath: string, outPath: string): Promise<void> {
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		"-i",
		inputPath,
		"-filter_complex",
		"showwavespic=s=1400x220:colors=0x22c1c3",
		"-frames:v",
		"1",
		"-y",
		outPath,
	]);
}

async function detectVolume(inputPath: string): Promise<VolumeStats> {
	const stderr = await runCommandCollectingStderr("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-i",
		inputPath,
		"-af",
		"volumedetect",
		"-f",
		"null",
		"-",
	]);
	return {
		meanDb: parseDb(stderr, /mean_volume:\s*(-?[0-9.]+)\s*dB/),
		maxDb: parseDb(stderr, /max_volume:\s*(-?[0-9.]+)\s*dB/),
	};
}

async function detectBoundarySilences(inputPath: string): Promise<CutRange[]> {
	const stderr = await runCommandCollectingStderr("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-i",
		inputPath,
		"-af",
		"silencedetect=noise=-38dB:d=0.15",
		"-f",
		"null",
		"-",
	]);
	const ranges: CutRange[] = [];
	let start: number | null = null;
	for (const line of stderr.split("\n")) {
		const startMatch = line.match(/silence_start:\s*(-?[0-9.]+)/);
		if (startMatch) {
			start = Number(startMatch[1]);
			continue;
		}
		const endMatch = line.match(/silence_end:\s*(-?[0-9.]+)/);
		if (endMatch && start !== null) {
			ranges.push({ start: Math.max(0, start), end: Number(endMatch[1]) });
			start = null;
		}
	}
	return ranges;
}

function renderReport(manifest: {
	capPath: string;
	outputRoot: string;
	windowSec: number;
	outputDurationSec: number;
	boundaries: BoundaryArtifact[];
}): string {
	const lines = [
		"# Transition Debug Report",
		"",
		`Cap: \`${manifest.capPath}\``,
		`Output duration: ${manifest.outputDurationSec.toFixed(3)}s`,
		`Audio window: ${manifest.windowSec.toFixed(2)}s before + after each join`,
		"",
		"Review method:",
		"1. Play `boundary-preview.mp4`; judge the actual edit by eye and ear, not transcript continuity.",
		"2. Open each contact sheet and compare the last three before frames to the first three after frames.",
		"3. Play `boundary-audio.wav` if you need audio-only focus.",
		"4. Use `waveform.png` to spot clicks, abrupt ambience changes, or missing breath/context around the cut.",
		"5. Treat big cursor jumps as a warning that the zoom likely needs a manual target or the cut needs more setup.",
		"",
		`Open \`${join(manifest.outputRoot, "review.html")}\` for one page with all frame sheets, waveforms, and audio controls.`,
		"",
		"## Boundaries",
		"",
	];

	for (const b of manifest.boundaries) {
		lines.push(`### ${b.label}`);
		lines.push("");
		lines.push(`- Output join: ${b.outputTime.toFixed(3)}s`);
		lines.push(
			`- Source join: rec ${b.prev.recordingSegment} @ ${b.prev.sourceTime.toFixed(3)}s -> rec ${b.next.recordingSegment} @ ${b.next.sourceTime.toFixed(3)}s`,
		);
		if (b.previewMp4) lines.push(`- Preview video: \`${b.previewMp4}\``);
		lines.push(`- Contact sheet: \`${b.contactSheet}\``);
		if (b.audioWav) lines.push(`- Audio snippet: \`${b.audioWav}\``);
		if (b.waveform) lines.push(`- Waveform: \`${b.waveform}\``);
		lines.push(`- Cursor jump: ${b.cursorJump === null ? "n/a" : `${b.cursorJump.toFixed(1)}px`}`);
		if (b.volumedetect) {
			lines.push(
				`- Audio level: mean ${formatNullableDb(b.volumedetect.meanDb)}, max ${formatNullableDb(b.volumedetect.maxDb)}`,
			);
		}
		if (b.silences.length > 0) {
			lines.push(
				`- Silence in snippet: ${b.silences
					.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}s`)
					.join(", ")}`,
			);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function renderHtml(manifest: {
	capPath: string;
	outputRoot: string;
	windowSec: number;
	outputDurationSec: number;
	boundaries: BoundaryArtifact[];
}): string {
	const cards = manifest.boundaries
		.map((b) => {
			const contact = relativeArtifactPath(manifest.outputRoot, b.contactSheet);
			const preview = b.previewMp4 ? relativeArtifactPath(manifest.outputRoot, b.previewMp4) : null;
			const waveform = b.waveform ? relativeArtifactPath(manifest.outputRoot, b.waveform) : null;
			const audio = b.audioWav ? relativeArtifactPath(manifest.outputRoot, b.audioWav) : null;
			return `<section class="card">
	<h2>${escapeHtml(b.label)} <span>@ ${b.outputTime.toFixed(3)}s</span></h2>
	<p>rec ${b.prev.recordingSegment} @ ${b.prev.sourceTime.toFixed(3)}s -> rec ${b.next.recordingSegment} @ ${b.next.sourceTime.toFixed(3)}s | cursor jump ${b.cursorJump === null ? "n/a" : `${b.cursorJump.toFixed(1)}px`} | audio ${b.volumedetect ? `mean ${formatNullableDb(b.volumedetect.meanDb)}, max ${formatNullableDb(b.volumedetect.maxDb)}` : "n/a"}</p>
	${preview ? `<video controls preload="metadata" src="${escapeHtml(preview)}"></video>` : ""}
	<img src="${escapeHtml(contact)}" alt="${escapeHtml(b.label)} contact sheet">
	${waveform ? `<img class="waveform" src="${escapeHtml(waveform)}" alt="${escapeHtml(b.label)} waveform">` : ""}
	${audio ? `<audio controls preload="metadata" src="${escapeHtml(audio)}"></audio>` : ""}
</section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Transition Debug Review</title>
<style>
	body { margin: 0; padding: 32px; background: #101414; color: #edf7f5; font-family: ui-sans-serif, system-ui, sans-serif; }
	header { max-width: 1200px; margin: 0 auto 24px; }
	h1 { margin: 0 0 8px; font-size: 32px; }
	p { color: #b8cbc8; line-height: 1.45; }
	.card { max-width: 2200px; margin: 0 auto 28px; padding: 20px; border: 1px solid #29413d; border-radius: 18px; background: #17201f; box-shadow: 0 18px 50px rgba(0,0,0,.28); }
	h2 { display: flex; gap: 12px; align-items: baseline; margin: 0 0 4px; }
	h2 span { color: #79c7bc; font-size: 16px; }
	video, img { display: block; width: 100%; border-radius: 10px; margin-top: 14px; background: #000; }
	audio { display: block; width: 100%; margin-top: 14px; }
</style>
</head>
<body>
<header>
	<h1>Transition Debug Review</h1>
	<p>Cap: ${escapeHtml(manifest.capPath)}</p>
	<p>Use this page to judge the cut by eye and ear: contact sheet first, then waveform, then the actual boundary audio.</p>
</header>
${cards}
</body>
</html>
`;
}

function requireRecordingPaths(
	pathsBySegment: Map<number, RecordingSegmentPaths>,
	recordingSegment: number,
): RecordingSegmentPaths {
	const paths = pathsBySegment.get(recordingSegment);
	if (!paths) throw new Error(`No recording metadata for segment ${recordingSegment}`);
	return paths;
}

function runCommand(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args);
		let stderr = "";
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
		});
	});
}

function runCommandCollectingStderr(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args);
		let stderr = "";
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0 || code === null) resolve(stderr);
			else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
		});
	});
}

function parseDb(text: string, pattern: RegExp): number | null {
	const match = text.match(pattern);
	return match ? Number(match[1]) : null;
}

function positiveNumber(raw: string, flag: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
	return n;
}

function positiveInteger(raw: string, flag: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
	return n;
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, -5);
}

function formatNullableDb(value: number | null): string {
	return value === null ? "n/a" : `${value.toFixed(1)} dB`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function relativeArtifactPath(root: string, path: string): string {
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
