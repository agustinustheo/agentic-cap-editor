import { copyFile, mkdir, readFile, writeFile, stat, access } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { parseArgs, requirePositional } from "./lib/cli.ts";

interface SourceVideoMeta {
	path: string;
	fps?: number;
	start_time?: number | null;
	device_id?: string | null;
}

interface SourceAudioMeta {
	path: string;
	start_time?: number | null;
	device_id?: string | null;
}

interface SourceSegment {
	display: SourceVideoMeta;
	camera?: SourceVideoMeta | null;
	mic?: SourceAudioMeta | null;
	system_audio?: SourceAudioMeta | null;
	cursor?: string | null;
	keyboard?: string | null;
}

interface SourceMeta {
	platform?: string | null;
	pretty_name?: string;
	segments?: SourceSegment[];
	cursors?: Record<string, Record<string, unknown>>;
	status?: Record<string, unknown>;
}

const args = parseArgs(
	{
		include: { type: "string", multiple: true, default: [] as string[] },
		force: { type: "boolean", default: false },
		name: { type: "string" },
	},
	process.argv.slice(2),
);

const outputName = requirePositional(args.positionals, 0, "output-name");
const sources = args.positionals.slice(1);
if (sources.length === 0) {
	console.error("error: at least one <source.cap> is required");
	process.exit(2);
}

const rawIncludes = (args.values.include as string | string[] | undefined) ?? [];
const includeArr = Array.isArray(rawIncludes) ? rawIncludes : [rawIncludes];

function parseIncludeList(spec: string, total: number): number[] {
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const range = trimmed.match(/^(\d+)\.\.(\d+)$/);
		if (range) {
			const lo = Number(range[1]);
			const hi = Number(range[2]);
			for (let i = lo; i <= hi; i++) out.add(i);
			continue;
		}
		const n = Number(trimmed);
		if (!Number.isInteger(n) || n < 0 || n >= total) {
			throw new Error(`invalid segment index ${trimmed} (source has ${total} segments)`);
		}
		out.add(n);
	}
	return [...out].sort((a, b) => a - b);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

const sourcesData: { dir: string; meta: SourceMeta; include: number[] }[] = [];
for (let i = 0; i < sources.length; i++) {
	const dir = resolve(sources[i]!);
	const metaPath = join(dir, "recording-meta.json");
	if (!(await pathExists(metaPath))) {
		console.error(`error: ${dir} is not a .cap bundle (no recording-meta.json)`);
		process.exit(1);
	}
	const meta = JSON.parse(await readFile(metaPath, "utf8")) as SourceMeta;
	if (!Array.isArray(meta.segments)) {
		console.error(
			`error: ${dir} is not a studio recording (no segments[] array). The merge tool only works with studio recordings.`,
		);
		process.exit(1);
	}
	const total = meta.segments.length;
	let include: number[];
	if (includeArr[i]) {
		try {
			include = parseIncludeList(includeArr[i]!, total);
		} catch (err) {
			console.error(`error: source ${i} (${dir}): ${(err as Error).message}`);
			process.exit(2);
		}
	} else {
		include = Array.from({ length: total }, (_, j) => j);
	}
	sourcesData.push({ dir, meta, include });
}

const outputDir = resolve("recordings/edited", `${outputName}.cap`);
if (await pathExists(outputDir)) {
	if (!args.values.force) {
		console.error(`error: ${outputDir} already exists. Pass --force to overwrite.`);
		process.exit(1);
	}
}
await mkdir(join(outputDir, "content/segments"), { recursive: true });
await mkdir(join(outputDir, "content/cursors"), { recursive: true });

interface MergedSegment {
	display: SourceVideoMeta;
	camera?: SourceVideoMeta;
	mic?: SourceAudioMeta;
	system_audio?: SourceAudioMeta;
	cursor?: string;
	keyboard?: string;
}

const mergedSegments: MergedSegment[] = [];
const mergedCursors: Record<string, Record<string, unknown>> = {};
const copiedSprites = new Set<string>();

function relativize(p: string, baseDir: string): string {
	const abs = resolve(baseDir, p);
	const rel = abs.substring(outputDir.length + 1);
	return rel;
}

let newSegIdx = 0;
for (let i = 0; i < sourcesData.length; i++) {
	const { dir, meta, include } = sourcesData[i]!;
	console.log(`# source ${i}: ${basename(dir)}  (including ${include.length} of ${meta.segments!.length})`);

	for (const j of include) {
		const sourceSeg = meta.segments![j]!;
		const newSegDir = join(outputDir, "content/segments", `segment-${newSegIdx}`);
		await mkdir(newSegDir, { recursive: true });

		const copies: Promise<unknown>[] = [];

		const newDisplayPath = `content/segments/segment-${newSegIdx}/display.mp4`;
		copies.push(
			copyFile(join(dir, sourceSeg.display.path), join(outputDir, newDisplayPath)),
		);
		const mergedSeg: MergedSegment = {
			display: {
				path: newDisplayPath,
				...(sourceSeg.display.fps !== undefined && { fps: sourceSeg.display.fps }),
				...(sourceSeg.display.start_time !== undefined && {
					start_time: sourceSeg.display.start_time,
				}),
			},
		};

		if (sourceSeg.camera?.path) {
			const newCameraPath = `content/segments/segment-${newSegIdx}/camera.mp4`;
			copies.push(copyFile(join(dir, sourceSeg.camera.path), join(outputDir, newCameraPath)));
			mergedSeg.camera = {
				path: newCameraPath,
				...(sourceSeg.camera.fps !== undefined && { fps: sourceSeg.camera.fps }),
				...(sourceSeg.camera.start_time !== undefined && {
					start_time: sourceSeg.camera.start_time,
				}),
				...(sourceSeg.camera.device_id !== undefined && {
					device_id: sourceSeg.camera.device_id,
				}),
			};
		}

		if (sourceSeg.mic?.path) {
			const ext = basename(sourceSeg.mic.path).split(".").pop() ?? "ogg";
			const newMicPath = `content/segments/segment-${newSegIdx}/audio-input.${ext}`;
			copies.push(copyFile(join(dir, sourceSeg.mic.path), join(outputDir, newMicPath)));
			mergedSeg.mic = {
				path: newMicPath,
				...(sourceSeg.mic.start_time !== undefined && {
					start_time: sourceSeg.mic.start_time,
				}),
				...(sourceSeg.mic.device_id !== undefined && {
					device_id: sourceSeg.mic.device_id,
				}),
			};
		}

		if (sourceSeg.system_audio?.path) {
			const ext = basename(sourceSeg.system_audio.path).split(".").pop() ?? "ogg";
			const newSysPath = `content/segments/segment-${newSegIdx}/system-audio.${ext}`;
			copies.push(
				copyFile(join(dir, sourceSeg.system_audio.path), join(outputDir, newSysPath)),
			);
			mergedSeg.system_audio = {
				path: newSysPath,
				...(sourceSeg.system_audio.start_time !== undefined && {
					start_time: sourceSeg.system_audio.start_time,
				}),
			};
		}

		if (sourceSeg.keyboard) {
			const newKbdPath = `content/segments/segment-${newSegIdx}/keyboard.bin`;
			copies.push(copyFile(join(dir, sourceSeg.keyboard), join(outputDir, newKbdPath)));
			mergedSeg.keyboard = newKbdPath;
		}

		if (sourceSeg.cursor) {
			const cursorRaw = await readFile(join(dir, sourceSeg.cursor), "utf8");
			interface CursorEvent {
				cursor_id?: string;
				[key: string]: unknown;
			}
			interface CursorFile {
				clicks?: CursorEvent[];
				moves?: CursorEvent[];
				[key: string]: unknown;
			}
			const cursorData = JSON.parse(cursorRaw) as CursorFile;
			const prefix = `b${i}_`;
			for (const c of cursorData.clicks ?? []) {
				if (typeof c.cursor_id === "string") c.cursor_id = prefix + c.cursor_id;
			}
			for (const m of cursorData.moves ?? []) {
				if (typeof m.cursor_id === "string") m.cursor_id = prefix + m.cursor_id;
			}
			const newCursorPath = `content/segments/segment-${newSegIdx}/cursor.json`;
			await writeFile(
				join(outputDir, newCursorPath),
				`${JSON.stringify(cursorData, null, 2)}\n`,
			);
			mergedSeg.cursor = newCursorPath;
		}

		await Promise.all(copies);
		mergedSegments.push(mergedSeg);
		console.log(`  seg ${newSegIdx} ← source[${i}].segment-${j}`);
		newSegIdx++;
	}

	// Copy + rename cursor sprites
	const sourceCursors = meta.cursors ?? {};
	for (const [origId, info] of Object.entries(sourceCursors)) {
		const newId = `b${i}_${origId}`;
		const origImage = (info.imagePath ?? info.path) as string | undefined;
		if (!origImage) {
			mergedCursors[newId] = info;
			continue;
		}
		const origImageBase = basename(origImage);
		const newImageBase = origImageBase.replace(
			/^cursor_(.+)\.(\w+)$/,
			(_m, _id, ext) => `cursor_${newId}.${ext}`,
		);
		const newImagePath = `content/cursors/${newImageBase}`;
		const spriteKey = `${i}:${origImage}`;
		if (!copiedSprites.has(spriteKey)) {
			const sourceImageAbs = join(dir, origImage);
			if (await pathExists(sourceImageAbs)) {
				await copyFile(sourceImageAbs, join(outputDir, newImagePath));
			}
			copiedSprites.add(spriteKey);
		}
		const updated: Record<string, unknown> = { ...info };
		if ("imagePath" in info) updated.imagePath = newImagePath;
		else if ("path" in info) updated.path = newImagePath;
		mergedCursors[newId] = updated;
	}
}

// Build recording-meta.json
const baseMeta = sourcesData[0]!.meta;
const mergedMeta: Record<string, unknown> = {
	platform: baseMeta.platform ?? "MacOS",
	pretty_name: outputName,
	sharing: null,
	segments: mergedSegments,
	cursors: mergedCursors,
	status: { status: "Complete" },
};
await writeFile(
	join(outputDir, "recording-meta.json"),
	`${JSON.stringify(mergedMeta, null, 2)}\n`,
);

// Build project-config.json: start from source[0]'s, replace timeline
const source0ConfigPath = join(sourcesData[0]!.dir, "project-config.json");
let projectConfig: Record<string, unknown> = {};
if (await pathExists(source0ConfigPath)) {
	projectConfig = JSON.parse(await readFile(source0ConfigPath, "utf8")) as Record<string, unknown>;
}

interface TimelineSegment {
	recordingSegment: number;
	timescale: number;
	start: number;
	end: number;
}

const newTimelineSegments: TimelineSegment[] = [];
async function ffprobeDur(p: string): Promise<number> {
	const { spawn } = await import("node:child_process");
	return await new Promise<number>((resolve, reject) => {
		const proc = spawn("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			p,
		]);
		let stdout = "";
		proc.stdout.on("data", (b) => {
			stdout += b.toString();
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) reject(new Error(`ffprobe exit ${code}`));
			else resolve(Number(stdout.trim()));
		});
	});
}

for (let k = 0; k < mergedSegments.length; k++) {
	const seg = mergedSegments[k]!;
	const fullPath = join(outputDir, seg.display.path);
	const dur = await ffprobeDur(fullPath);
	newTimelineSegments.push({ recordingSegment: k, timescale: 1, start: 0, end: dur });
}

projectConfig.timeline = {
	segments: newTimelineSegments,
	zoomSegments: [],
	sceneSegments: [],
	maskSegments: [],
	textSegments: [],
	captionSegments: [],
	keyboardSegments: [],
};
await writeFile(
	join(outputDir, "project-config.json"),
	`${JSON.stringify(projectConfig, null, 2)}\n`,
);

const totalDur = newTimelineSegments.reduce((s, t) => s + (t.end - t.start) / t.timescale, 0);
const totalCursors = Object.keys(mergedCursors).length;
console.log("");
console.log(`merged ${mergedSegments.length} segment(s) into ${outputDir}`);
console.log(`  total duration: ${totalDur.toFixed(3)}s`);
console.log(`  cursors: ${totalCursors}`);
console.log(`  next: pnpm captions:add "${outputDir}"  → pnpm suggest:cuts ... → pnpm suggest:zooms ...`);
