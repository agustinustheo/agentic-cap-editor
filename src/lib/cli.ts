import { parseArgs as nodeParseArgs, type ParseArgsConfig } from "node:util";

export interface CliResult {
	positionals: string[];
	values: Record<string, string | boolean | undefined>;
}

export function parseArgs(
	options: ParseArgsConfig["options"],
	argv: string[] = process.argv.slice(2),
): CliResult {
	try {
		const result = nodeParseArgs({
			args: argv,
			options,
			allowPositionals: true,
		});
		return {
			positionals: result.positionals,
			values: result.values as CliResult["values"],
		};
	} catch (err) {
		console.error(`error: ${(err as Error).message}`);
		process.exit(2);
	}
}

export function requirePositional(positionals: string[], index: number, name: string): string {
	const v = positionals[index];
	if (!v) {
		console.error(`error: missing required argument <${name}>`);
		process.exit(2);
	}
	return v;
}

export function num(
	values: Record<string, string | boolean | undefined>,
	key: string,
): number | undefined {
	const v = values[key];
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) {
		console.error(`error: --${key} must be a number, got "${String(v)}"`);
		process.exit(2);
	}
	return n;
}

export function requireNum(
	values: Record<string, string | boolean | undefined>,
	key: string,
): number {
	const n = num(values, key);
	if (n === undefined) {
		console.error(`error: missing required option --${key}`);
		process.exit(2);
	}
	return n;
}
