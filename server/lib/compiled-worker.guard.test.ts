import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILED_WORKER_ENTRIES } from "./compiled-worker";

// Registration of each spawned worker is enforced by `compiledWorkerSpecifiers` taking a
// `CompiledWorkerEntry`. These checks cover what the type system cannot see.
const root = join(import.meta.dir, "../..");

function serverSources(): string[] {
	return [...new Bun.Glob("**/*.ts").scanSync({ cwd: join(root, "server") })].filter(
		(path) => !path.includes(".test.") && !path.includes("__tests__/"),
	);
}

test("production compile spreads the worker registry instead of listing worker paths", () => {
	const source = readFileSync(join(root, "scripts/build-cross-platform.ts"), "utf8");
	expect(source).toContain("...compiledWorkerBuildEntrypoints()");
	expect([...source.matchAll(/"(\.\/server\/[^"\r\n]+\.ts)"/g)].map((match) => match[1])).toEqual([
		"./server/index.ts",
	]);
	for (const entry of COMPILED_WORKER_ENTRIES) {
		expect(existsSync(join(root, "server", entry))).toBe(true);
	}
});

test("both editor IO workers remain production compile entries", () => {
	for (const entry of [
		"./server/services/editor-document-worker.ts",
		"./server/services/editor-document-stream-worker.ts",
	]) {
		expect(COMPILED_WORKER_ENTRIES.map((path) => `./server/${path}`)).toContain(entry);
	}
	expect(existsSync(join(root, "shared/compiled-worker-entries.ts"))).toBe(false);
});

test("worker spawns go through the shared resolver", () => {
	const offenders: string[] = [];
	for (const path of serverSources()) {
		const text = readFileSync(join(root, "server", path), "utf8");
		if (!text.includes("new Worker(") || path === "lib/compiled-worker.ts") continue;
		if (text.includes("eval: true") || text.includes("createObjectURL")) continue;
		// node:worker_threads rejects file: strings and Windows virtual URLs; the global Worker
		// accepts file: hrefs, including $bunfs.
		const routed = text.includes('from "node:worker_threads"')
			? text.includes("workerEntryFromSpecifier") || text.includes("connectCompiledWorker")
			: text.includes("compiledWorkerSpecifiers");
		if (!routed) offenders.push(path);
	}
	expect(offenders).toEqual([]);
}, 60000);

test("pooled and ephemeral database workers normalize Windows embedded virtual keys", () => {
	const text = readFileSync(join(root, "server/lib/db-worker/pool.ts"), "utf8");
	expect([...text.matchAll(/new Worker\(workerEntryFromSpecifier\(specifier\)\)/g)].length).toBe(2);
	expect(text).not.toContain("new Worker(specifier)");
});
