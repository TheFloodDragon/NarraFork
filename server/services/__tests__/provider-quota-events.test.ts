import { expect, mock, test } from "bun:test";
import {
	broadcastProviderQuotaInvalidation,
	type QuotaInvalidationSocket,
} from "../provider-quota-events";

test("quota invalidation is minimal, bounded, session-only and filtered to visible Custom API IDs", () => {
	const socket = (data: QuotaInvalidationSocket["data"], backlog = 0) => ({
		data,
		send: mock((_value: string) => 1),
		getBufferedAmount: () => backlog,
	});
	const normal = socket({ userId: "normal", sessionId: "session" });
	const admin = socket({ userId: "admin", sessionId: "session2" });
	const share = socket({ publicShare: {} });
	const external = socket({ userId: "external" });
	const saturated = socket({ userId: "normal", sessionId: "session" }, 1024 * 1024 + 1);
	broadcastProviderQuotaInvalidation(
		[normal, admin, share, external, saturated],
		{
			providerIds: ["custom-1", "custom-1", "nug-1", "codex", "private"],
			version: 4,
		},
		new Set(["custom-1"]),
	);
	for (const target of [normal, admin]) {
		expect(target.send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(target.send.mock.calls[0]?.[0] ?? "")).toEqual({
			type: "provider_quota_changed",
			providerIds: ["custom-1"],
			version: 4,
		});
	}
	for (const target of [share, external, saturated]) expect(target.send).not.toHaveBeenCalled();
});

test("a quota event never grows beyond 100 IDs or broadcasts an empty result", () => {
	const send = mock((_value: string) => 1);
	const ids = Array.from({ length: 200 }, (_, i) => `p-${i}`);
	const sockets = [{ data: { userId: "user", sessionId: "session" }, send }];
	broadcastProviderQuotaInvalidation(sockets, { providerIds: ids, version: 1 }, new Set(ids));
	expect(JSON.parse(send.mock.calls[0]?.[0] ?? "").providerIds).toHaveLength(100);
	broadcastProviderQuotaInvalidation(
		sockets,
		{ providerIds: ["missing"], version: 2 },
		new Set(ids),
	);
	expect(send).toHaveBeenCalledTimes(1);
});
