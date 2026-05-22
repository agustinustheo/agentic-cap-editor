import {
	cp,
	mkdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { loadBundle } from "./lib/cap.ts";
import { parseArgs, requirePositional } from "./lib/cli.ts";
import {
	cursorPositionAt,
	loadCursorEvents,
	recordingSegmentPaths,
	type CursorEvents,
} from "./lib/cursor.ts";
import { timelineDuration } from "./lib/timeline.ts";

const { positionals, values } = parseArgs({
	out: { type: "string" },
	force: { type: "boolean", default: false },
});

const capPath = requirePositional(positionals, 0, "path-to.cap");
const outPath = String(
	values.out ??
		join(dirname(capPath), `${capPath.replace(/\.cap$/, "").split("/").pop()} Baked.cap`),
);

type JsonObject = Record<string, unknown>;

function requireObject(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not an object`);
	}
	return value as JsonObject;
}

async function run(command: string, args: string[], label: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ["ignore", "inherit", "pipe"] });
		let stderr = "";
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${label} failed (${code}): ${stderr.trim()}`));
		});
	});
}

async function ffmpegVideo(
	input: string,
	output: string,
	start: number,
	duration: number,
	timescale: number,
	fps: number | undefined,
): Promise<void> {
	const vf = `setpts=PTS/${timescale}`;
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-ss",
		String(start),
		"-t",
		String(duration),
		"-i",
		input,
		"-an",
		"-vf",
		vf,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
	];
	if (fps && Number.isFinite(fps)) args.push("-r", String(fps));
	args.push(output);
	await run("ffmpeg", args, `ffmpeg video ${input}`);
}

async function ffmpegAudio(
	input: string,
	output: string,
	start: number,
	duration: number,
	timescale: number,
): Promise<void> {
	await run(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			String(start),
			"-t",
			String(duration),
			"-i",
			input,
			"-vn",
			"-filter:a",
			`atempo=${timescale}`,
			"-c:a",
			"libopus",
			output,
		],
		`ffmpeg audio ${input}`,
	);
}

function retimeEvents(events: CursorEvents | null, start: number, end: number, timescale: number): CursorEvents {
	if (!events) return { clicks: [], moves: [] };
	const startMs = start * 1000;
	const endMs = end * 1000;
	const mapTime = (timeMs: number) => (timeMs - startMs) / timescale;
	const moves = events.moves
		.filter((event) => event.time_ms >= startMs && event.time_ms <= endMs)
		.map((event) => ({ ...event, time_ms: mapTime(event.time_ms) }));
	const pos = cursorPositionAt(events, startMs);
	if (pos) {
		const template = moves[0] ?? events.moves.find((event) => event.time_ms >= startMs) ?? events.moves.at(-1);
		if (template) {
			moves.unshift({
				...template,
				time_ms: 0,
				x: pos.x,
				y: pos.y,
			});
		}
	}
	const clicks = events.clicks
		.filter((event) => event.time_ms >= startMs && event.time_ms <= endMs)
		.map((event) => ({ ...event, time_ms: mapTime(event.time_ms) }));
	return { clicks, moves };
}

async function main(): Promise<void> {
	const bundle = await loadBundle(capPath);
	const timeline = bundle.config.timeline;
	if (!timeline || timeline.segments.length === 0) {
		throw new Error("Cannot bake a project with no timeline.segments");
	}
	const outputExists = await stat(outPath).then(
		() => true,
		() => false,
	);
	if (outputExists) {
		if (!values.force) {
			throw new Error(`Output exists: ${outPath}. Pass --force to replace it.`);
		}
		await rm(outPath, { recursive: true, force: true });
	}

	const sourceMeta = bundle.meta as JsonObject;
	const sourceSegments = sourceMeta.segments as JsonObject[] | undefined;
	if (!Array.isArray(sourceSegments)) {
		throw new Error("bake:timeline currently supports studio multi-segment .cap bundles");
	}

	const sourceRecordings = recordingSegmentPaths(bundle);
	await mkdir(join(outPath, "content", "segments"), { recursive: true });
	await cp(join(capPath, "content", "cursors"), join(outPath, "content", "cursors"), {
		recursive: true,
	});

	const newSegments: JsonObject[] = [];
	const newTimelineSegments = [];
	for (const [index, segment] of timeline.segments.entries()) {
		const sourceIndex = segment.recordingSegment;
		const sourceSegment = sourceSegments[sourceIndex];
		const sourceRecording = sourceRecordings[sourceIndex];
		if (!sourceSegment || !sourceRecording) {
			throw new Error(`timeline segment ${index} references missing recordingSegment ${sourceIndex}`);
		}
		const segmentDir = join(outPath, "content", "segments", `segment-${index}`);
		await mkdir(segmentDir, { recursive: true });

		const sourceDuration = segment.end - segment.start;
		const bakedDuration = sourceDuration / segment.timescale;
		const display = requireObject(sourceSegment.display, `segment ${sourceIndex}.display`);
		const displayOut = `content/segments/segment-${index}/display.mp4`;
		console.log(
			`[${index + 1}/${timeline.segments.length}] rec ${sourceIndex} ${segment.start.toFixed(3)}-${segment.end.toFixed(3)} x${segment.timescale} -> ${bakedDuration.toFixed(3)}s`,
		);
		await ffmpegVideo(
			join(capPath, String(display.path)),
			join(outPath, displayOut),
			segment.start,
			sourceDuration,
			segment.timescale,
			Number(display.fps),
		);

		const bakedSegment: JsonObject = {
			display: {
				...display,
				path: displayOut,
				start_time: 0,
			},
		};

		if (sourceSegment.camera) {
			const camera = requireObject(sourceSegment.camera, `segment ${sourceIndex}.camera`);
			const cameraOut = `content/segments/segment-${index}/camera.mp4`;
			await ffmpegVideo(
				join(capPath, String(camera.path)),
				join(outPath, cameraOut),
				segment.start,
				sourceDuration,
				segment.timescale,
				Number(camera.fps),
			);
			bakedSegment.camera = { ...camera, path: cameraOut, start_time: 0 };
		}

		const mic = (sourceSegment.mic ?? sourceSegment.audio) as JsonObject | undefined;
		if (mic?.path) {
			const audioOut = `content/segments/segment-${index}/audio-input.ogg`;
			await ffmpegAudio(
				join(capPath, String(mic.path)),
				join(outPath, audioOut),
				segment.start,
				sourceDuration,
				segment.timescale,
			);
			bakedSegment.mic = { ...mic, path: audioOut, start_time: 0 };
		}

		if (sourceSegment.systemAudio) {
			const systemAudio = requireObject(sourceSegment.systemAudio, `segment ${sourceIndex}.systemAudio`);
			const audioOut = `content/segments/segment-${index}/system-audio.ogg`;
			await ffmpegAudio(
				join(capPath, String(systemAudio.path)),
				join(outPath, audioOut),
				segment.start,
				sourceDuration,
				segment.timescale,
			);
			bakedSegment.systemAudio = { ...systemAudio, path: audioOut, start_time: 0 };
		}

		if (sourceRecording.cursorPath) {
			const cursorOut = `content/segments/segment-${index}/cursor.json`;
			const events = await loadCursorEvents(sourceRecording.cursorPath);
			await writeFile(
				join(outPath, cursorOut),
				`${JSON.stringify(retimeEvents(events, segment.start, segment.end, segment.timescale), null, 2)}\n`,
			);
			bakedSegment.cursor = cursorOut;
		}

		newSegments.push(bakedSegment);
		newTimelineSegments.push({
			recordingSegment: index,
			timescale: 1,
			start: 0,
			end: bakedDuration,
		});
	}

	const newMeta = {
		...sourceMeta,
		pretty_name: outPath.replace(/.*\//, "").replace(/\.cap$/, ""),
		segments: newSegments,
		status: { status: "Complete" },
	};
	await writeFile(join(outPath, "recording-meta.json"), `${JSON.stringify(newMeta, null, 2)}\n`);

	const newConfig = {
		...bundle.config,
		timeline: {
			...timeline,
			segments: newTimelineSegments,
		},
		clips: newTimelineSegments.map((_, index) => ({
			index,
			offsets: { camera: 0, mic: 0, system_audio: 0 },
		})),
	};
	await writeFile(join(outPath, "project-config.json"), `${JSON.stringify(newConfig, null, 2)}\n`);

	try {
		const captionsJson = await readFile(join(capPath, "captions.json"), "utf8");
		await writeFile(join(outPath, "captions.json"), captionsJson);
	} catch {
	}

	console.log("");
	console.log(`baked cap: ${outPath}`);
	console.log(`timeline/export duration: ${timelineDuration(timeline.segments).toFixed(3)}s`);
}

main().catch((err) => {
	console.error(`error: ${(err as Error).message}`);
	process.exit(1);
});
