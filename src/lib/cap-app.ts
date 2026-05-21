import { spawn } from "node:child_process";

export async function isCapAppRunning(): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	return await new Promise<boolean>((resolve) => {
		const proc = spawn("pgrep", ["-x", "Cap"], { stdio: "ignore" });
		proc.on("error", () => resolve(false));
		proc.on("close", (code) => resolve(code === 0));
	});
}

export async function closeCapApp(): Promise<void> {
	if (process.platform !== "darwin") return;
	await new Promise<void>((resolve) => {
		const proc = spawn("osascript", ["-e", 'tell application "Cap" to quit'], {
			stdio: "ignore",
		});
		proc.on("error", () => resolve());
		proc.on("close", () => resolve());
	});
}
