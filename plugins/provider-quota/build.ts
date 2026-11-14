import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import manifest from "./manifest.json";

const SOURCE_ROOT = import.meta.dir;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
// A fixed UTC timestamp and entry mode make package contents and ZIP metadata reproducible.
// The ZIP epoch is also a valid SPDX creation time; this is not the machine's build clock.
const BUILD_TIMESTAMP = "1980-01-01T00:00:00.000Z";
export interface BuildProviderQuotaOptions {
	outDir?: string;
}
export interface BuildProviderQuotaResult {
	archivePath: string;
	packageRoot: string;
}
async function cappedRead(path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size > maxBytes)
			throw new Error(`Build input exceeds byte budget: ${relative(SOURCE_ROOT, path)}`);
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead === 0) throw new Error("Build input changed while reading");
			offset += bytesRead;
		}
		const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, offset);
		if (bytesRead !== 0) throw new Error("Build input changed while reading");
		return bytes;
	} finally {
		await handle.close();
	}
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Builds only this independently installable plugin; no host settings, DB or runtime imports. */
export async function buildProviderQuotaPlugin(
	options: BuildProviderQuotaOptions = {},
): Promise<BuildProviderQuotaResult> {
	const sourceBytes = await cappedRead(join(SOURCE_ROOT, "plugin-source.json"), 16 * 1024);
	const metadata = JSON.parse(sourceBytes.toString("utf8"));
	if (
		metadata?.schemaVersion !== 1 ||
		metadata.pluginId !== manifest.pluginId ||
		metadata.source?.type !== "local" ||
		metadata.source.builtinId !== manifest.pluginId ||
		Object.keys(metadata).sort().join(",") !== "pluginId,schemaVersion,source" ||
		Object.keys(metadata.source).sort().join(",") !== "builtinId,type"
	)
		throw new Error(
			"Provider Quota source metadata must be its local builtin identity without a homepage",
		);
	const outDir = resolve(options.outDir ?? join(SOURCE_ROOT, "dist"));
	const packageRoot = join(outDir, "package");
	const serverRoot = join(packageRoot, "server");
	await mkdir(serverRoot, { recursive: true });
	await mkdir(join(packageRoot, "licenses"), { recursive: true });
	await mkdir(join(packageRoot, "sources", "src"), { recursive: true });
	const built = await Bun.build({
		entrypoints: [join(SOURCE_ROOT, "src", "index.ts")],
		outdir: serverRoot,
		target: "bun",
		format: "esm",
		minify: true,
		sourcemap: "none",
		naming: "index.js",
	});
	if (!built.success)
		throw new Error(
			`Provider quota build failed: ${built.logs.map((log) => log.message).join("; ")}`,
		);
	const files = [
		"server/index.js",
		"manifest.json",
		"plugin-source.json",
		"LICENSE",
		"licenses/zod.LICENSE",
	];
	await writeFile(join(packageRoot, "plugin-source.json"), sourceBytes);
	await copyFile(join(SOURCE_ROOT, "manifest.json"), join(packageRoot, "manifest.json"));
	await copyFile(join(SOURCE_ROOT, "LICENSE"), join(packageRoot, "LICENSE"));
	const zodJsonPath = fileURLToPath(import.meta.resolve("zod/package.json"));
	const zodMetadataBytes = await cappedRead(zodJsonPath);
	const zod = JSON.parse(zodMetadataBytes.toString("utf8")) as {
		name: string;
		version: string;
		license: string;
	};
	if (zod.name !== "zod" || zod.version !== "4.3.6" || zod.license !== "MIT")
		throw new Error("Bundled zod metadata differs from the independent package dependency");
	await copyFile(
		join(dirname(zodJsonPath), "LICENSE"),
		join(packageRoot, "licenses", "zod.LICENSE"),
	);
	// MPL source availability accompanies the package, rather than pointing at host directories.
	for (const entry of await readdir(join(SOURCE_ROOT, "src"), { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		if (files.length >= 64) throw new Error("Build source file count exceeds budget");
		await cappedRead(join(SOURCE_ROOT, "src", entry.name));
		await copyFile(
			join(SOURCE_ROOT, "src", entry.name),
			join(packageRoot, "sources", "src", entry.name),
		);
		files.push(`sources/src/${entry.name}`);
	}
	for (const name of [
		"package.json",
		"tsconfig.json",
		"manifest.json",
		"plugin-source.json",
		"build.ts",
		"LICENSE",
	]) {
		if (name === "plugin-source.json") {
			await writeFile(join(packageRoot, "sources", name), sourceBytes);
		} else {
			await cappedRead(join(SOURCE_ROOT, name));
			await copyFile(join(SOURCE_ROOT, name), join(packageRoot, "sources", name));
		}
		files.push(`sources/${name}`);
	}
	files.sort();
	let totalBytes = 0;
	const fileRecords = [];
	const fileSha1s = [];
	for (const [index, file] of files.entries()) {
		const bytes = await cappedRead(join(packageRoot, file));
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("Build package exceeds byte budget");
		fileSha1s.push(createHash("sha1").update(bytes).digest("hex"));
		fileRecords.push({
			SPDXID: `SPDXRef-File-${index}`,
			fileName: `./${file}`,
			checksums: [{ algorithm: "SHA256", checksumValue: sha256(bytes) }],
			licenseConcluded:
				file === "server/index.js"
					? "MPL-2.0 AND MIT"
					: file === "licenses/zod.LICENSE"
						? "MIT"
						: "MPL-2.0",
			copyrightText: "NOASSERTION",
		});
	}
	const packageVerificationCode = createHash("sha1")
		.update(fileSha1s.sort().join(""))
		.digest("hex");
	const sbom = {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: manifest.pluginId,
		documentNamespace: `https://narrafork.local/sbom/${manifest.pluginId}/${manifest.version}/${packageVerificationCode}`,
		creationInfo: {
			created: BUILD_TIMESTAMP,
			creators: ["Organization: NarraFork", `Tool: Bun-${Bun.version}`],
		},
		packages: [
			{
				SPDXID: "SPDXRef-provider-quota",
				name: manifest.pluginId,
				versionInfo: manifest.version,
				downloadLocation: "NOASSERTION",
				licenseDeclared: manifest.license,
				licenseConcluded: manifest.license,
				filesAnalyzed: true,
				packageVerificationCode: {
					packageVerificationCodeValue: packageVerificationCode,
					packageVerificationCodeExcludedFiles: ["sbom.spdx.json"],
				},
				supplier: "Organization: NarraFork",
			},
			{
				SPDXID: "SPDXRef-zod",
				name: zod.name,
				versionInfo: zod.version,
				downloadLocation: `https://registry.npmjs.org/zod/-/zod-${zod.version}.tgz`,
				filesAnalyzed: false,
				licenseDeclared: zod.license,
				licenseConcluded: zod.license,
				sourceInfo: `Bundled from installed zod package.json SHA256 ${sha256(zodMetadataBytes)}; see licenses/zod.LICENSE and server/index.js`,
				externalRefs: [
					{
						referenceCategory: "PACKAGE-MANAGER",
						referenceType: "purl",
						referenceLocator: `pkg:npm/zod@${zod.version}`,
					},
				],
			},
		],
		files: fileRecords,
		relationships: [
			{
				spdxElementId: "SPDXRef-DOCUMENT",
				relationshipType: "DESCRIBES",
				relatedSpdxElement: "SPDXRef-provider-quota",
			},
			{
				spdxElementId: "SPDXRef-provider-quota",
				relationshipType: "DEPENDS_ON",
				relatedSpdxElement: "SPDXRef-zod",
			},
			...fileRecords.map((file) => ({
				spdxElementId: "SPDXRef-provider-quota",
				relationshipType: "CONTAINS",
				relatedSpdxElement: file.SPDXID,
			})),
		],
	};
	await writeFile(join(packageRoot, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);
	files.push("sbom.spdx.json");
	files.sort();
	const archivePath = join(outDir, "provider-quota.nfplugin");
	const archive = archiver("zip", { zlib: { level: 9 }, forceLocalTime: false });
	let archiveBytes = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			archiveBytes += chunk.byteLength;
			callback(
				archiveBytes > MAX_ARCHIVE_BYTES ? new Error("Build archive exceeds byte budget") : null,
				chunk,
			);
		},
	});
	const sink = createWriteStream(archivePath);
	const completed = pipeline(archive, limiter, sink);
	const timer = setTimeout(() => {
		archive.abort();
		sink.destroy(new Error("Build archive deadline exceeded"));
	}, 30_000);
	try {
		for (const file of files) {
			// Append bounded bytes, not filesystem stats (mtime/mode vary by machine and checkout).
			archive.append(await cappedRead(join(packageRoot, file)), {
				name: file,
				date: new Date(BUILD_TIMESTAMP),
				mode: 0o644,
			});
		}
		await Promise.all([archive.finalize(), completed]);
	} finally {
		clearTimeout(timer);
	}
	return { archivePath, packageRoot };
}
if (import.meta.main) console.log(JSON.stringify(await buildProviderQuotaPlugin()));
