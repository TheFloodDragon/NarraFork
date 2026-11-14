import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { safeSpawn } from "./spawn";

// Windows may perform the one-time inheritable-handle scan before the first spawn.
setDefaultTimeout(30_000);

const child = (source: string) => [process.execPath, "-e", source];

describe("safeSpawn opt-in streaming", () => {
	test("default capture still returns stdout and stderr", async () => {
		const result = await safeSpawn({
			cmd: child('process.stdout.write("out"); process.stderr.write("err")'),
			timeout: 5000,
		});
		expect(result.stdout).toBe("out");
		expect(result.stderr).toBe("err");
		expect(result).not.toHaveProperty("terminationReason");
	});

	test("infinite output is killed at the byte budget without retained stdout", async () => {
		let bytes = 0;
		const result = await safeSpawn({
			cmd: child('setInterval(() => process.stdout.write("x".repeat(16384)), 1)'),
			timeout: 5000,
			stdoutStream: {
				maxBytes: 1234,
				onChunk: (chunk) => {
					bytes += chunk.byteLength;
					return undefined;
				},
			},
		});
		expect(bytes).toBe(1234);
		expect(result.stdout).toBe("");
		expect(result.terminationReason).toBe("output-limit");
		expect(result.stdoutTruncated).toBe(true);
	});

	test("consumer stop is distinct and stderr is capped independently", async () => {
		const result = await safeSpawn({
			cmd: child(
				'process.stderr.write("e".repeat(20000)); setInterval(() => process.stdout.write("ok"), 10)',
			),
			timeout: 5000,
			maxStderrBytes: 4096,
			stdoutStream: { maxBytes: 10000, onChunk: () => false },
		});
		expect(result.terminationReason).toBe("consumer");
		expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(4096);
		expect(result.stderrTruncated).toBe(true);
	});

	test("hard timeout is distinguishable from an intentional stop", async () => {
		const result = await safeSpawn({
			cmd: child("setInterval(() => {}, 1000)"),
			timeout: 100,
			stdoutStream: { maxBytes: 1000, onChunk: () => true },
		});
		expect(result.terminationReason).toBe("timeout");
	});

	test("abort terminates the stream and records cancellation", async () => {
		const controller = new AbortController();
		const result = await safeSpawn({
			cmd: child('setInterval(() => process.stdout.write("ok"), 1)'),
			timeout: 5000,
			signal: controller.signal,
			stdoutStream: {
				maxBytes: 10000,
				onChunk: () => {
					controller.abort();
					return undefined;
				},
			},
		});
		expect(result.terminationReason).toBe("abort");
	});

	test("consumer exceptions terminate the producer rather than leak it", async () => {
		await expect(
			safeSpawn({
				cmd: child('setInterval(() => process.stdout.write("ok"), 1)'),
				timeout: 5000,
				stdoutStream: {
					maxBytes: 10000,
					onChunk: () => {
						throw new Error("parse failed");
					},
				},
			}),
		).rejects.toThrow("parse failed");
	});
});
