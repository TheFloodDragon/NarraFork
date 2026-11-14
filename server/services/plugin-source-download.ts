import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
	type PluginSource,
	type ResolvedPluginRelease,
} from "@shared/plugin-source";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	fetchPluginSource,
	type LocalSourceDescriptor,
	PluginSourceFailure,
	type PluginSourceTransport,
	safeSourceUrl,
	sourceAbortable,
	sourceDownloadPolicy,
} from "./plugin-source-resolvers";

// Deliberately self-contained eval worker: also works in a frozen binary without
// resolving a sibling worker path. No hashing fallback is allowed on the host thread.
const HASH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { open } = require('node:fs/promises');
(async () => {
  let file;
  try {
    file = await open(workerData.path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > workerData.maxBytes) throw new Error('invalid');
    const hash = createHash('sha256');
    const buffer = new Uint8Array(65536);
    let size = 0;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > workerData.maxBytes) throw new Error('large');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (size !== stat.size) throw new Error('changed');
    parentPort.postMessage({ sha256: hash.digest('hex'), size });
  } catch { parentPort.postMessage({ error: 'hash_failed' }); }
  finally { if (file) await file.close(); }
})();`;

export interface PluginArchiveDigest {
	sha256: string;
	size: number;
}
export interface PluginHashWorker {
	on(event: "message", listener: (value: unknown) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "exit", listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

export async function hashPluginArchive(
	path: string,
	options: {
		signal: AbortSignal;
		timeoutMs?: number;
		workerFactory?: (path: string) => PluginHashWorker;
	},
): Promise<PluginArchiveDigest> {
	options.signal.throwIfAborted();
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new PluginSourceFailure("apply_failed")),
		Math.min(120_000, options.timeoutMs ?? 120_000),
	);
	const signal = AbortSignal.any([options.signal, timeout.signal]);
	let worker: PluginHashWorker | undefined;
	try {
		worker =
			options.workerFactory?.(path) ??
			new Worker(HASH_WORKER, {
				eval: true,
				workerData: { path, maxBytes: PLUGIN_UPDATE_MAX_ARCHIVE_BYTES },
			});
		const connected = worker;
		const result = new Promise<PluginArchiveDigest>((resolve, reject) => {
			connected.on("message", (raw) => {
				const value = raw as Partial<PluginArchiveDigest> | null;
				if (
					!value ||
					typeof value.sha256 !== "string" ||
					!/^[a-f0-9]{64}$/.test(value.sha256) ||
					typeof value.size !== "number" ||
					!Number.isSafeInteger(value.size) ||
					!value.size ||
					value.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES
				)
					reject(new PluginSourceFailure("apply_failed"));
				else resolve({ sha256: value.sha256, size: value.size });
			});
			connected.on("error", () => reject(new PluginSourceFailure("apply_failed")));
			connected.on("exit", () => reject(new PluginSourceFailure("apply_failed")));
		});
		return await sourceAbortable(result, signal);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		throw error instanceof PluginSourceFailure ? error : new PluginSourceFailure("apply_failed");
	} finally {
		clearTimeout(timer);
		await worker?.terminate().catch(() => {});
	}
}

export interface DownloadedPluginArchive {
	path: string;
	cleanup(): Promise<void>;
}
export interface PluginArchiveDownloadOptions {
	signal: AbortSignal;
	transport: PluginSourceTransport;
	stagingRoot?: string;
	getBuiltin(id: string): LocalSourceDescriptor | undefined;
	onProgress?(downloadedBytes: number, totalBytes: number): void;
	/** Test injection exercises the isolated computation directly; production always uses a Worker. */
	hashArchive?: typeof hashPluginArchive;
}

export async function downloadPluginArchive(
	source: PluginSource,
	release: ResolvedPluginRelease,
	options: PluginArchiveDownloadOptions,
): Promise<DownloadedPluginArchive> {
	if (
		!Number.isSafeInteger(release.size) ||
		release.size <= 0 ||
		release.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES ||
		!/^[a-f0-9]{64}$/.test(release.sha256)
	)
		throw new PluginSourceFailure("invalid_release");
	options.signal.throwIfAborted();
	const root = options.stagingRoot ?? getNarraforkPath("plugin-update-staging");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(join(root, "download-"));
	const path = join(staging, "plugin.nfplugin");
	const cleanup = () => rm(staging, { recursive: true, force: true });
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		options.signal.throwIfAborted();
		file = await open(path, "wx", 0o600);
		const writer = file;
		let written = 0;
		const write = async (bytes: Uint8Array) => {
			if (
				written + bytes.byteLength > release.size ||
				written + bytes.byteLength > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES
			)
				throw new PluginSourceFailure("size_mismatch");
			let offset = 0;
			while (offset < bytes.byteLength) {
				options.signal.throwIfAborted();
				const result = await sourceAbortable(
					writer.write(bytes, offset, bytes.byteLength - offset, written),
					options.signal,
				);
				if (!result.bytesWritten) throw new PluginSourceFailure("apply_failed");
				offset += result.bytesWritten;
				written += result.bytesWritten;
			}
			options.onProgress?.(written, release.size);
		};
		if (release.artifact.type === "local") {
			const descriptor = options.getBuiltin(release.artifact.builtinId);
			if (
				!descriptor ||
				descriptor.pluginId !== release.pluginId ||
				descriptor.version !== release.version
			)
				throw new PluginSourceFailure("local_missing");
			const loaded = await sourceAbortable(descriptor.load(options.signal), options.signal);
			if (loaded.sha256 !== release.sha256) throw new PluginSourceFailure("hash_mismatch");
			if (loaded.bytes.byteLength !== release.size) throw new PluginSourceFailure("size_mismatch");
			for (let offset = 0; offset < loaded.bytes.byteLength; offset += 64 * 1024)
				await write(loaded.bytes.subarray(offset, offset + 64 * 1024));
		} else {
			const policy = sourceDownloadPolicy(source, release.artifact.url);
			const response = await fetchPluginSource(
				safeSourceUrl(release.artifact.url, policy.allowHttp),
				policy.origins,
				options,
				policy.allowHttp,
			);
			if (!response.ok || !response.body) {
				void response.body?.cancel().catch(() => {});
				throw new PluginSourceFailure("request_failed");
			}
			const declared = response.headers.get("content-length");
			if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== release.size)) {
				void response.body.cancel().catch(() => {});
				throw new PluginSourceFailure("size_mismatch");
			}
			const reader = response.body.getReader();
			const cancel = () => {
				void reader.cancel().catch(() => {});
			};
			options.signal.addEventListener("abort", cancel, { once: true });
			try {
				for (;;) {
					const chunk = await sourceAbortable(reader.read(), options.signal);
					if (chunk.done) break;
					await write(chunk.value);
				}
			} finally {
				options.signal.removeEventListener("abort", cancel);
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
		if (written !== release.size) throw new PluginSourceFailure("size_mismatch");
		await file.close();
		file = undefined;
		const digest = await (options.hashArchive ?? hashPluginArchive)(path, {
			signal: options.signal,
		});
		options.signal.throwIfAborted();
		if (digest.size !== release.size) throw new PluginSourceFailure("size_mismatch");
		if (digest.sha256 !== release.sha256) throw new PluginSourceFailure("hash_mismatch");
		return { path, cleanup };
	} catch (error) {
		await file?.close().catch(() => {});
		await cleanup().catch(() => {});
		if (options.signal.aborted) throw options.signal.reason;
		throw error instanceof PluginSourceFailure ? error : new PluginSourceFailure("apply_failed");
	}
}
