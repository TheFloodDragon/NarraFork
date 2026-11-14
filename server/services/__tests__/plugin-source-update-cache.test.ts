import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getNarraforkPath } from "../../lib/narrafork-home";
import type { PluginSourceService } from "../plugin-source-service";
import {
	type PersistedPluginUpdateSummary,
	PluginSourceUpdateCache,
} from "../plugin-source-update-cache";
import {
	SOURCE_PLUGIN_ID,
	sourceDrain,
	sourceServiceFixture,
	sourceSha,
} from "./plugin-source-fixtures";

let root: string;
let filePath: string;
const services: PluginSourceService[] = [];
beforeEach(async () => {
	const parent = getNarraforkPath("plugin-summary-tests");
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "run-"));
	filePath = join(root, "summary.json");
});
afterEach(async () => {
	for (const service of services.splice(0)) await service.stop();
	await rm(root, { recursive: true, force: true });
});
function entry(pluginId = SOURCE_PLUGIN_ID, notes?: string): PersistedPluginUpdateSummary {
	return {
		pluginId,
		installationId: crypto.randomUUID(),
		current: { version: "1.0.0", hash: "1".repeat(64) },
		sourceRevision: 0,
		view: {
			pluginId,
			status: "available",
			installedVersion: "1.0.0",
			checkedAt: "2026-11-14T00:00:00Z",
			latest: { version: "1.2.3", size: 1234, sha256: sourceSha, ...(notes ? { notes } : {}) },
			error: null,
		},
	};
}

describe("bounded atomic private plugin update summaries", () => {
	test("persists actual checked summaries and restores them across instances", async () => {
		const value = entry();
		const first = new PluginSourceUpdateCache({ filePath });
		await first.save(value);
		await first.flush();
		const restored = await new PluginSourceUpdateCache({ filePath }).get(SOURCE_PLUGIN_ID);
		expect(restored).toEqual(value);
		expect(await readdir(root)).toEqual(["summary.json"]);
	});

	test("bad, oversized, mismatched and capability-containing legacy summaries degrade to unknown", async () => {
		for (const raw of [
			"not JSON",
			"x".repeat(512 * 1024 + 1),
			JSON.stringify({
				schemaVersion: 1,
				entries: [{ ...entry(), view: { ...entry().view, candidateId: "must-not-revive" } }],
			}),
			JSON.stringify({ schemaVersion: 1, entries: [{ ...entry(), pluginId: "io.other.plugin" }] }),
		]) {
			await writeFile(filePath, raw);
			expect(await new PluginSourceUpdateCache({ filePath }).get(SOURCE_PLUGIN_ID)).toBeNull();
		}
	});

	test("disk budgets limit both summary count and UTF-8 byte size", async () => {
		const small = Array.from({ length: 256 }, (_, i) => entry(`io.example.small${i}`));
		await writeFile(filePath, JSON.stringify({ schemaVersion: 1, entries: small }));
		const countStore = new PluginSourceUpdateCache({ filePath });
		await countStore.save(entry("io.example.extra"));
		let document = JSON.parse(await readFile(filePath, "utf8"));
		expect(document.entries).toHaveLength(256);
		expect(await countStore.get("io.example.small0")).toBeNull();
		const large = Array.from({ length: 110 }, (_, i) =>
			entry(`io.example.large${i}`, "Details ".repeat(480)),
		);
		await writeFile(filePath, JSON.stringify({ schemaVersion: 1, entries: large }));
		const bytesStore = new PluginSourceUpdateCache({ filePath });
		for (let i = 0; i < 24; i++)
			await bytesStore.save(entry(`io.example.new${i}`, "Details ".repeat(480)));
		const raw = await readFile(filePath, "utf8");
		document = JSON.parse(raw);
		expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(512 * 1024);
		expect(document.entries.length).toBeLessThan(134);
		expect(await readdir(root)).toEqual(["summary.json"]);
	}, 20_000);
});

describe("source service restart summaries never revive update capabilities", () => {
	test("restores last checked/latest only; a new check is required for apply", async () => {
		const fixture = sourceServiceFixture(join(root, "staging"), {
			summaries: new PluginSourceUpdateCache({ filePath }),
		});
		services.push(fixture.service);
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(check.jobId);
		const first = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(first.candidateId).toBeString();
		const oldCandidateId = first.candidateId;
		if (!oldCandidateId) throw new Error("Expected the pre-restart candidate");
		await fixture.service.stop();
		const restarted = sourceServiceFixture(join(root, "staging"), {
			manager: fixture.manager,
			summaries: new PluginSourceUpdateCache({ filePath }),
		});
		services.push(restarted.service);
		const restored = await restarted.service.getUpdates(SOURCE_PLUGIN_ID);
		expect(restored).toMatchObject({
			status: "available",
			checkedAt: first.checkedAt,
			latest: { version: "1.2.3" },
		});
		expect(restored.candidateId).toBeUndefined();
		expect(restored.jobId).toBeUndefined();
		expect(restarted.service.getJob(check.jobId)).toBeNull();
		await expect(
			restarted.service.apply(SOURCE_PLUGIN_ID, oldCandidateId, 0),
		).rejects.toMatchObject({ code: "source_changed" });
		expect(restarted.fetch).not.toHaveBeenCalled();
		const raw = await readFile(filePath, "utf8");
		expect(raw).not.toMatch(/candidateId|jobId|https:|artifact|Authorization/);
	});

	test("restores fixed errors and rejects stale source revision, hash or installation UUID", async () => {
		const fixture = sourceServiceFixture(join(root, "staging"), {
			summaries: new PluginSourceUpdateCache({ filePath }),
		});
		services.push(fixture.service);
		fixture.fetch.mockRejectedValue(new Error("private NF secret in upstream error"));
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(check.jobId);
		await fixture.service.stop();
		const restored = sourceServiceFixture(join(root, "staging"), {
			manager: fixture.manager,
			summaries: new PluginSourceUpdateCache({ filePath }),
		});
		services.push(restored.service);
		expect(await restored.service.getUpdates(SOURCE_PLUGIN_ID)).toMatchObject({
			status: "error",
			error: "request_failed",
		});
		expect(await readFile(filePath, "utf8")).not.toContain("private NF secret");
		fixture.manager.install(SOURCE_PLUGIN_ID);
		const replacement = sourceServiceFixture(join(root, "staging"), {
			manager: fixture.manager,
			summaries: new PluginSourceUpdateCache({ filePath }),
		});
		services.push(replacement.service);
		expect(await replacement.service.getUpdates(SOURCE_PLUGIN_ID)).toMatchObject({
			status: "idle",
			latest: null,
		});
	});

	test("source changes and uninstall clear actual persisted summaries", async () => {
		const store = new PluginSourceUpdateCache({ filePath });
		const fixture = sourceServiceFixture(join(root, "staging"), { summaries: store });
		services.push(fixture.service);
		fixture.service.start();
		await sourceDrain();
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(check.jobId);
		expect(await store.get(SOURCE_PLUGIN_ID)).not.toBeNull();
		await fixture.service.setSource(SOURCE_PLUGIN_ID, null, 0);
		await store.flush();
		expect(await new PluginSourceUpdateCache({ filePath }).get(SOURCE_PLUGIN_ID)).toBeNull();
		fixture.manager.install(SOURCE_PLUGIN_ID);
		fixture.advance(10_000);
		const next = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(next.jobId);
		fixture.manager.uninstall(SOURCE_PLUGIN_ID);
		await fixture.service.stop();
		expect(await new PluginSourceUpdateCache({ filePath }).get(SOURCE_PLUGIN_ID)).toBeNull();
	});
});
