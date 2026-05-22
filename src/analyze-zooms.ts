import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadBundle, type TimelineSegment, type ZoomSegment } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import {
	cursorPositionAt,
	loadCursorEvents,
	recordingSegmentPaths,
	type CursorEvents,
} from "./lib/cursor.ts";
import { extractFrame } from "./lib/ffmpeg.ts";

interface TimelineSegmentWithOffset extends TimelineSegment {
	outputStart: number;
	outputEnd: number;
}

interface ZoomFinding {
	index: number;
	start: number;
	end: number;
	amount: number;
	mode: string;
	source: {
		recordingSegment: number;
		timeSec: number;
	};
	target: { x: number; y: number } | null;
	cursorTravel: number | null;
	warnings: string[];
	fullFrame: string | null;
	cropFrame: string | null;
}

const { positionals, values } = parseArgs({
	out: { type: "string" },
	json: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const bundle = await loadBundle(capPath);
const timeline = bundle.config.timeline;

if (!timeline || timeline.segments.length === 0) {
	throw new Error("This project has no timeline segments to map zooms against.");
}

const zooms = timeline.zoomSegments ?? [];
const recordings = recordingSegmentPaths(bundle);
const recordingsByIndex = new Map(recordings.map((r) => [r.recordingSegment, r]));
const timelineWithOffsets = addTimelineOffsets(timeline.segments);
const cursorCache = new Map<number, CursorEvents | null>();
const outputRoot = resolve(
	String(
		values.out ??
			join(
				"/tmp",
				"agentic-cap-editor",
				"zooms",
				`${slug(basename(capPath, ".cap"))}-${timestamp()}`,
			),
	),
);

await mkdir(outputRoot, { recursive: true });

const findings: ZoomFinding[] = [];
for (const [index, zoom] of zooms.entries()) {
	findings.push(await analyzeZoom(index, zoom));
}

const report = {
	capPath: bundle.path,
	outputRoot,
	zoomCount: zooms.length,
	findings,
};

await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outputRoot, "report.md"), renderMarkdown(report));
await writeFile(join(outputRoot, "review.html"), renderHtml(report));

if (values.json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`zoom debug artifacts: ${outputRoot}`);
	for (const f of findings) {
		const warning = f.warnings.length ? ` | ${f.warnings.join("; ")}` : "";
		const target = f.target ? `target=(${f.target.x.toFixed(2)}, ${f.target.y.toFixed(2)})` : "target=n/a";
		const travel = f.cursorTravel === null ? "travel=n/a" : `travel=${f.cursorTravel.toFixed(2)}`;
		console.log(
			`[${f.index}] ${f.start.toFixed(3)}-${f.end.toFixed(3)} x${f.amount} ${f.mode} ${target} ${travel}${warning}`,
		);
	}
	console.log(`report: ${join(outputRoot, "report.md")}`);
	console.log(`review: ${join(outputRoot, "review.html")}`);
}

async function analyzeZoom(index: number, zoom: ZoomSegment): Promise<ZoomFinding> {
	const mid = (zoom.start + zoom.end) / 2;
	const mapped = outputToSource(timelineWithOffsets, mid);
	if (!mapped) {
		return emptyFinding(index, zoom, ["zoom midpoint is outside the timeline"]);
	}

	const rec = recordingsByIndex.get(mapped.recordingSegment);
	if (!rec) {
		return emptyFinding(index, zoom, [`recording segment ${mapped.recordingSegment} not found`]);
	}

	const events = await eventsForRecording(mapped.recordingSegment);
	const cursorStart = events ? cursorAtOutput(zoom.start, events) : null;
	const cursorMid = events ? cursorPositionAt(events, mapped.timeSec * 1000) : null;
	const cursorEnd = events ? cursorAtOutput(zoom.end, events) : null;
	const target = zoom.mode === "auto" ? cursorMid : zoom.mode.manual;
	const cursorTravel = cursorStart && cursorEnd ? Math.hypot(cursorEnd.x - cursorStart.x, cursorEnd.y - cursorStart.y) : null;
	const warnings = zoomWarnings(zoom, target, cursorTravel);
	const dir = join(outputRoot, `zoom-${String(index).padStart(2, "0")}`);
	await mkdir(dir, { recursive: true });

	const fullFrame = join(dir, "full-frame.png");
	await extractFrame(rec.displayPath, { at: mapped.timeSec, outPath: fullFrame });

	let cropFrame: string | null = null;
	if (target) {
		cropFrame = join(dir, "simulated-crop.png");
		await extractCrop(rec.displayPath, mapped.timeSec, target, zoom.amount, cropFrame);
	}

	return {
		index,
		start: zoom.start,
		end: zoom.end,
		amount: zoom.amount,
		mode: zoom.mode === "auto" ? "auto" : "manual",
		source: mapped,
		target,
		cursorTravel,
		warnings,
		fullFrame,
		cropFrame,
	};
}

function emptyFinding(index: number, zoom: ZoomSegment, warnings: string[]): ZoomFinding {
	return {
		index,
		start: zoom.start,
		end: zoom.end,
		amount: zoom.amount,
		mode: zoom.mode === "auto" ? "auto" : "manual",
		source: { recordingSegment: -1, timeSec: -1 },
		target: null,
		cursorTravel: null,
		warnings,
		fullFrame: null,
		cropFrame: null,
	};
}

async function eventsForRecording(recordingSegment: number): Promise<CursorEvents | null> {
	if (cursorCache.has(recordingSegment)) return cursorCache.get(recordingSegment)!;
	const rec = recordingsByIndex.get(recordingSegment);
	const events = rec?.cursorPath ? await loadCursorEvents(rec.cursorPath) : null;
	cursorCache.set(recordingSegment, events);
	return events;
}

function cursorAtOutput(outputTime: number, events: CursorEvents): { x: number; y: number } | null {
	const mapped = outputToSource(timelineWithOffsets, outputTime);
	if (!mapped) return null;
	return cursorPositionAt(events, mapped.timeSec * 1000);
}

function zoomWarnings(
	zoom: ZoomSegment,
	target: { x: number; y: number } | null,
	cursorTravel: number | null,
): string[] {
	const warnings: string[] = [];
	if (zoom.mode === "auto" && cursorTravel !== null && cursorTravel > 0.22) {
		warnings.push("auto zoom follows large cursor travel; consider splitting or manual target");
	}
	if (target && (target.x < 0.18 || target.x > 0.82 || target.y < 0.18 || target.y > 0.82)) {
		warnings.push("target is near an edge; manual framing may look better");
	}
	if (zoom.end - zoom.start > 5 && zoom.mode === "auto") {
		warnings.push("long auto zoom; likely to drift during cursor movement");
	}
	return warnings;
}

async function extractCrop(
	videoPath: string,
	at: number,
	target: { x: number; y: number },
	amount: number,
	outPath: string,
): Promise<void> {
	const dims = await videoDimensions(videoPath);
	const cropW = Math.max(2, Math.round(dims.width / amount / 2) * 2);
	const cropH = Math.max(2, Math.round(dims.height / amount / 2) * 2);
	const x = clamp(Math.round(target.x * dims.width - cropW / 2), 0, dims.width - cropW);
	const y = clamp(Math.round(target.y * dims.height - cropH / 2), 0, dims.height - cropH);
	await runCommand("ffmpeg", [
		"-hide_banner",
		"-nostats",
		"-loglevel",
		"error",
		"-ss",
		String(at),
		"-i",
		videoPath,
		"-frames:v",
		"1",
		"-vf",
		`crop=${cropW}:${cropH}:${x}:${y},scale=1280:-2`,
		"-y",
		outPath,
	]);
}

async function videoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
	const stdout = await runCommandCollectingStdout("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height",
		"-of",
		"csv=s=x:p=0",
		videoPath,
	]);
	const [rawWidth, rawHeight] = stdout.trim().split("x").map(Number);
	if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) {
		throw new Error(`Could not parse video dimensions for ${videoPath}: ${stdout}`);
	}
	const width = rawWidth as number;
	const height = rawHeight as number;
	return { width, height };
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

function outputToSource(
	segments: TimelineSegmentWithOffset[],
	outputTime: number,
): { recordingSegment: number; timeSec: number } | null {
	for (const s of segments) {
		if (outputTime < s.outputStart || outputTime > s.outputEnd) continue;
		return {
			recordingSegment: s.recordingSegment,
			timeSec: s.start + (outputTime - s.outputStart) * s.timescale,
		};
	}
	return null;
}

function renderMarkdown(report: { capPath: string; findings: ZoomFinding[] }): string {
	const lines = [
		"# Zoom Debug Report",
		"",
		`Cap: \`${report.capPath}\``,
		"",
		"Review method:",
		"1. Open `review.html` and compare the full frame to the simulated crop for each zoom.",
		"2. Flag long auto zooms, edge targets, and large cursor travel; those usually need manual targets or split zooms.",
		"3. Use `zoom:remove` + `zoom:add --x --y` to replace problematic spans.",
		"",
	];
	for (const f of report.findings) {
		lines.push(`## zoom ${f.index}`);
		lines.push("");
		lines.push(`- Output: ${f.start.toFixed(3)}-${f.end.toFixed(3)}s, x${f.amount}, ${f.mode}`);
		lines.push(`- Source: rec ${f.source.recordingSegment} @ ${f.source.timeSec.toFixed(3)}s`);
		lines.push(`- Target: ${f.target ? `${f.target.x.toFixed(3)}, ${f.target.y.toFixed(3)}` : "n/a"}`);
		lines.push(`- Cursor travel: ${f.cursorTravel === null ? "n/a" : f.cursorTravel.toFixed(3)}`);
		if (f.warnings.length) lines.push(`- Warnings: ${f.warnings.join("; ")}`);
		if (f.fullFrame) lines.push(`- Full frame: \`${f.fullFrame}\``);
		if (f.cropFrame) lines.push(`- Simulated crop: \`${f.cropFrame}\``);
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function renderHtml(report: { capPath: string; outputRoot: string; findings: ZoomFinding[] }): string {
	const cards = report.findings
		.map((f) => {
			const full = f.fullFrame ? rel(report.outputRoot, f.fullFrame) : null;
			const crop = f.cropFrame ? rel(report.outputRoot, f.cropFrame) : null;
			return `<section class="card">
	<h2>zoom ${f.index} <span>${f.start.toFixed(2)}-${f.end.toFixed(2)}s</span></h2>
	<p>x${f.amount} ${f.mode} | target ${f.target ? `${f.target.x.toFixed(2)}, ${f.target.y.toFixed(2)}` : "n/a"} | travel ${f.cursorTravel === null ? "n/a" : f.cursorTravel.toFixed(2)}</p>
	${f.warnings.length ? `<p class="warn">${escapeHtml(f.warnings.join("; "))}</p>` : ""}
	<div class="grid">
		${full ? `<figure><figcaption>full frame</figcaption><img src="${escapeHtml(full)}"></figure>` : ""}
		${crop ? `<figure><figcaption>simulated zoom crop</figcaption><img src="${escapeHtml(crop)}"></figure>` : ""}
	</div>
</section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Zoom Debug Review</title>
<style>
	body { margin: 0; padding: 32px; background: #111615; color: #f0f8f6; font-family: ui-sans-serif, system-ui, sans-serif; }
	header, .card { max-width: 1700px; margin: 0 auto 24px; }
	.card { padding: 18px; border: 1px solid #2c4944; border-radius: 18px; background: #18211f; }
	h1 { margin: 0 0 8px; }
	h2 { margin: 0; }
	h2 span { color: #7bd2c5; font-size: 16px; }
	p { color: #bfd3d0; }
	.warn { color: #ffd166; }
	.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
	figure { margin: 0; }
	figcaption { color: #8fb0aa; margin: 0 0 8px; }
	img { width: 100%; border-radius: 10px; background: #000; }
</style>
</head>
<body>
<header>
	<h1>Zoom Debug Review</h1>
	<p>${escapeHtml(report.capPath)}</p>
</header>
${cards}
</body>
</html>
`;
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

function runCommandCollectingStdout(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (b) => {
			stdout += b.toString();
		});
		proc.stderr.on("data", (b) => {
			stderr += b.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
		});
	});
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

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function rel(root: string, path: string): string {
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
