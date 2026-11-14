import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	PLUGIN_UPDATE_ERROR_CODES,
	PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
	type PluginUpdateView,
	pluginSourceIdSchema,
	pluginSourceVersionSchema,
} from "@shared/plugin-source";
import { z } from "zod";
import { getNarraforkPath } from "../lib/narrafork-home";
import { sourceAbortable } from "./plugin-source-resolvers";

const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 256;
async function boundedSummaryIO<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("Plugin update summary IO timed out")),
		5_000,
	);
	try {
		return await sourceAbortable(operation(controller.signal), controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
const summaryViewSchema = z
	.object({
		pluginId: pluginSourceIdSchema,
		status: z.enum(["idle", "up_to_date", "available", "manual_required", "error"]),
		installedVersion: pluginSourceVersionSchema,
		checkedAt: z.string().datetime({ offset: true }).nullable(),
		latest: z
			.object({
				version: pluginSourceVersionSchema,
				size: z.number().int().positive().max(PLUGIN_UPDATE_MAX_ARCHIVE_BYTES),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				publishedAt: z.string().datetime({ offset: true }).optional(),
				notes: z.string().max(4096).optional(),
			})
			.strict()
			.nullable(),
		error: z.enum(PLUGIN_UPDATE_ERROR_CODES).nullable(),
	})
	.strict();
const entrySchema = z
	.object({
		pluginId: pluginSourceIdSchema,
		installationId: z.string().uuid(),
		current: z
			.object({ version: pluginSourceVersionSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) })
			.strict(),
		sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		view: summaryViewSchema,
	})
	.strict()
	.refine(
		(entry) =>
			entry.pluginId === entry.view.pluginId &&
			entry.current.version === entry.view.installedVersion,
	);
const documentSchema = z
	.object({ schemaVersion: z.literal(1), entries: z.array(entrySchema).max(MAX_ENTRIES) })
	.strict();
export type PersistedPluginUpdateSummary = z.infer<typeof entrySchema>;
export interface PluginUpdateSummaryStore {
	get(pluginId: string): Promise<PersistedPluginUpdateSummary | null>;
	save(entry: PersistedPluginUpdateSummary): Promise<void>;
	remove(pluginId: string): Promise<void>;
	flush(): Promise<void>;
}

/** Private bounded summaries, never sources, credentials, artifact URLs, jobs or candidate IDs. */
export class PluginSourceUpdateCache implements PluginUpdateSummaryStore {
	private entries = new Map<string, PersistedPluginUpdateSummary>();
	private sizes = new Map<string, number>();
	private totalBytes = 32;
	private loadPromise?: Promise<void>;
	private writer: Promise<void> = Promise.resolve();
	private readonly filePath: string;

	constructor(options: { filePath?: string } = {}) {
		this.filePath = options.filePath ?? getNarraforkPath("plugin-update-summary.json");
	}
	private load(): Promise<void> {
		this.loadPromise ??= boundedSummaryIO((signal) => this.read(signal)).catch(() => {
			this.entries.clear();
			this.sizes.clear();
			this.totalBytes = 32;
		});
		return this.loadPromise;
	}
	private async read(signal: AbortSignal): Promise<void> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const info = await lstat(this.filePath);
			signal.throwIfAborted();
			if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return;
			handle = await open(this.filePath, "r");
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.dev !== info.dev ||
				opened.ino !== info.ino ||
				opened.size > MAX_BYTES
			)
				return;
			const bytes = new Uint8Array(MAX_BYTES + 1);
			let length = 0;
			while (length < bytes.byteLength) {
				signal.throwIfAborted();
				const chunk = await handle.read(bytes, length, bytes.byteLength - length, length);
				if (!chunk.bytesRead) break;
				length += chunk.bytesRead;
			}
			if (length > MAX_BYTES) return;
			const raw = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
			);
			const document = documentSchema.safeParse(raw);
			if (!document.success) return;
			signal.throwIfAborted();
			for (const entry of document.data.entries) this.upsert(entry);
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error;
		} finally {
			await handle?.close();
		}
	}
	private upsert(entry: PersistedPluginUpdateSummary): void {
		this.totalBytes -= this.sizes.get(entry.pluginId) ?? 0;
		this.entries.delete(entry.pluginId);
		this.sizes.delete(entry.pluginId);
		const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
		this.entries.set(entry.pluginId, structuredClone(entry));
		this.sizes.set(entry.pluginId, size);
		this.totalBytes += size;
		while (this.entries.size > MAX_ENTRIES || this.totalBytes > MAX_BYTES - 128) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.totalBytes -= this.sizes.get(oldest) ?? 0;
			this.sizes.delete(oldest);
			this.entries.delete(oldest);
		}
	}
	async get(pluginId: string): Promise<PersistedPluginUpdateSummary | null> {
		await this.load();
		const entry = this.entries.get(pluginId);
		return entry ? structuredClone(entry) : null;
	}
	async save(value: PersistedPluginUpdateSummary): Promise<void> {
		await this.load();
		const parsed = entrySchema.safeParse(value);
		if (!parsed.success) throw new Error("Invalid plugin update summary");
		this.upsert(parsed.data);
		await this.write();
	}
	async remove(pluginId: string): Promise<void> {
		await this.load();
		if (!this.entries.delete(pluginId)) return;
		this.totalBytes -= this.sizes.get(pluginId) ?? 0;
		this.sizes.delete(pluginId);
		await this.write();
	}
	private write(): Promise<void> {
		const operation = this.writer
			.catch(() => {})
			.then(() =>
				boundedSummaryIO(async (signal) => {
					const serialized = JSON.stringify({
						schemaVersion: 1,
						entries: [...this.entries.values()],
					});
					if (Buffer.byteLength(serialized) > MAX_BYTES)
						throw new Error("Plugin update summary exceeded its byte budget");
					const directory = dirname(this.filePath);
					await mkdir(directory, { recursive: true, mode: 0o700 });
					signal.throwIfAborted();
					const temporary = join(
						directory,
						`.${basename(this.filePath)}-${crypto.randomUUID()}.tmp`,
					);
					let handle: Awaited<ReturnType<typeof open>> | undefined;
					try {
						handle = await open(temporary, "wx", 0o600);
						await handle.writeFile(serialized, "utf8");
						await handle.sync();
						await handle.close();
						handle = undefined;
						signal.throwIfAborted();
						await rename(temporary, this.filePath);
					} finally {
						await handle?.close().catch(() => {});
						await rm(temporary, { force: true }).catch(() => {});
					}
				}),
			);
		this.writer = operation;
		return operation;
	}
	async flush(): Promise<void> {
		await this.loadPromise;
		await this.writer;
	}
}

/** Deliberate field projection strips ephemeral capabilities before disk persistence. */
export function pluginUpdateSummaryView(
	view: PluginUpdateView,
): PersistedPluginUpdateSummary["view"] | null {
	if (view.status === "checking" || view.status === "no_source" || !view.installedVersion)
		return null;
	return {
		pluginId: view.pluginId,
		status: view.status,
		installedVersion: view.installedVersion,
		checkedAt: view.checkedAt,
		latest: view.latest,
		error: view.error,
	};
}
