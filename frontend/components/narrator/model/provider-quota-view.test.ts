import { describe, expect, test } from "bun:test";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import { createInstance } from "i18next";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { customApiQuotaDisplayFor } from "./custom-api-usage-source";
import { buildProviderQuotaView, formatProviderQuotaAmount } from "./provider-quota-view";
import { formatQuotaBadgeText, formatQuotaSummaryLines } from "./quota-panel-view";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	defaultNS: "narrator",
});
const t = i18n.getFixedT("en", "narrator");
const snapshot = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
	providerId: "p1",
	targetId: "custom-api/p1",
	generation: "account-A",
	sourceId: "com.example.third-party:credits-v7",
	status: "supported",
	data: {
		amounts: [
			{
				id: "credits",
				label: "Project credits",
				unit: "credits",
				remaining: 37.5,
				used: 12.5,
				total: 50,
			},
		],
		windows: [
			{
				id: "rolling",
				label: "Rolling requests",
				unit: "requests",
				used: 40,
				limit: 100,
				remaining: 60,
				resetAt: "2026-01-01T01:00:00Z",
			},
		],
		format: "not-a-core-enum",
		planName: "Team plan",
	},
	fetchedAt: 100,
	attemptedAt: 100,
	stale: false,
	error: null,
	version: 1,
	...overrides,
});

function requireView(value: ReturnType<typeof buildProviderQuotaView>) {
	if (!value) throw new Error("expected normalized quota view");
	return value;
}

describe("normalized provider quota view", () => {
	test("unknown third-party sources render ordinary amounts and windows", () => {
		const view = requireView(buildProviderQuotaView(snapshot(), t));
		expect(view.windows[0]).toMatchObject({
			id: "rolling",
			remainingPercent: 60,
			used: 40,
			limit: 100,
			level: "ok",
			resetAt: Date.parse("2026-01-01T01:00:00Z"),
		});
		expect(view.rows).toContainEqual({
			id: "amount/credits",
			label: "Project credits",
			value: "credits 37.5",
		});
		expect(view.rows).toContainEqual({
			id: "amount/credits/usage",
			label: "Project credits used / total",
			value: "credits 12.5 / credits 50",
		});
		expect(formatQuotaBadgeText(view, t)).toContain("60%");
		expect(formatQuotaSummaryLines(view, 100, t).join("\n")).toContain("Team plan");
		expect(
			buildProviderQuotaView({ ...snapshot(), sourceId: "another.plugin:anything" }, t),
		).toEqual(view);
	});

	test("amount-only sources use the same panel, not a branded formatter", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: { amounts: [{ id: "wallet", unit: "EUR", remaining: 0.004 }], windows: [] },
				}),
				t,
			),
		);
		expect(view.windows).toEqual([]);
		expect(formatQuotaBadgeText(view, t)).toBe("EUR 0.004");
		expect(view.level).toBe("ok");
	});

	test("unknown values never turn into zero, full allowance or unlimited", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [{ id: "unknown", unit: "USD", remaining: null }],
						windows: [{ id: "unknown", used: null, limit: null, remaining: null, resetAt: null }],
					},
				}),
				t,
			),
		);
		expect(view.windows[0]).toMatchObject({
			usedPercent: null,
			remainingPercent: null,
			used: null,
			limit: null,
			level: "unknown",
		});
		expect(view.rows[0]?.value).toBe("Unknown");
		expect(view.level).toBe("unknown");
		expect(formatQuotaSummaryLines(view, 0, t).join("\n")).not.toMatch(/Unlimited|100%/);
		expect(formatProviderQuotaAmount({ id: "zero", unit: "USD", remaining: 0 }, t)).toBe("USD 0");
		expect(
			formatProviderQuotaAmount(
				{ id: "unlimited", unit: "requests", remaining: null, unlimited: true },
				t,
			),
		).toBe("Unlimited");
	});

	test("percent-only and rate-limited windows remain honest without numeric limits", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [],
						windows: [
							{
								id: "percent",
								used: null,
								limit: null,
								remaining: null,
								usedPercent: 75,
								resetAt: null,
							},
							{
								id: "blocked",
								used: null,
								limit: null,
								remaining: null,
								status: "rate-limited",
								resetAt: null,
							},
						],
					},
				}),
				t,
			),
		);
		expect(view.windows[0]).toMatchObject({
			remainingPercent: 25,
			used: null,
			limit: null,
			level: "warning",
		});
		expect(view.windows[1]).toMatchObject({ remainingPercent: null, level: "exhausted" });
		expect(view.limiting?.id).toBe("blocked");
	});

	test("same-account stale good values stay visible; fixed error details are admin-only", () => {
		const failed = snapshot({
			status: "error",
			error: "request_failed",
			stale: true,
			attemptedAt: 200,
		});
		const view = requireView(buildProviderQuotaView(failed, t));
		expect(view.rows[0]?.value).toBe("credits 37.5");
		expect(view.windows[0]?.remainingPercent).toBe(60);
		expect(view.failed).toBe(true);
		expect(view.fetchedAt).toBe(100);
		expect(view.failureDetail).toBeNull();
		expect(buildProviderQuotaView(failed, t, true)?.failureDetail).toBe(
			"The quota request failed.",
		);
		expect(buildProviderQuotaView(snapshot(), t, false, true)?.failed).toBe(true);
	});

	test.each([
		["admin", "en"],
		["user", "en"],
		["admin", "zh-CN"],
		["user", "zh-CN"],
	])("unavailable sources hide both empty and cached quotas (%s, %s)", (role, locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const unavailableStates: Partial<ProviderQuotaSnapshot>[] = [
			{ status: "unavailable", error: null },
			{ status: "unavailable", error: "request_failed" },
			{ status: "supported", error: "unavailable" },
			{ status: "error", error: "unavailable" },
			{ status: "pending", error: "unavailable" },
			{ status: "probing", error: "unavailable" },
			{ status: "unsupported", error: "unavailable" },
		];
		for (const state of unavailableStates) {
			for (const data of [null, snapshot().data]) {
				const unavailable = snapshot({ ...state, data, stale: true });
				for (const queryFailed of [false, true]) {
					expect(
						buildProviderQuotaView(unavailable, translate, role === "admin", queryFailed),
					).toBeNull();
				}
			}
		}
	});

	test.each(["en", "zh-CN"])("reinstalling a supported source restores its view (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const good = snapshot();
		expect(buildProviderQuotaView(good, translate)).not.toBeNull();
		expect(
			buildProviderQuotaView(
				{ ...good, status: "unavailable", error: "unavailable", version: 2 },
				translate,
			),
		).toBeNull();
		const restored = requireView(buildProviderQuotaView(snapshot({ version: 3 }), translate));
		expect(restored.rows[0]?.value).toBe("credits 37.5");
		expect(restored.windows[0]?.remainingPercent).toBe(60);
		expect(restored.failed).toBe(false);
	});

	test.each([
		["admin", "en"],
		["user", "en"],
		["admin", "zh-CN"],
		["user", "zh-CN"],
	])("real request and permission failures keep quota data and diagnostics (%s, %s)", (role, locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		for (const error of [
			"request_failed",
			"permission_denied",
			"auth_failed",
			"timeout",
		] as const) {
			const failed = snapshot({ status: "error", error, stale: true });
			const view = requireView(buildProviderQuotaView(failed, translate, role === "admin"));
			expect(view.rows[0]?.value).toBe("credits 37.5");
			expect(view.windows[0]?.remainingPercent).toBe(60);
			expect(view.failed).toBe(true);
			expect(view.failureDetail).toBe(
				role === "admin" ? translate(`providerQuota.errors.${error}`) : null,
			);
		}
	});

	test.each([
		"en",
		"zh-CN",
	])("real zero balances and unavailable accounts remain visible (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [{ id: "wallet", unit: "USD", remaining: 0 }],
						windows: [],
						available: false,
					},
				}),
				translate,
			),
		);
		expect(formatQuotaBadgeText(view, translate)).toBe("USD 0");
		expect(view.level).toBe("exhausted");
		expect(view.rows).toContainEqual({
			id: "meta/availability",
			label: translate("providerQuota.availability"),
			value: translate("providerQuota.accountUnavailable"),
		});
	});

	test.each([
		"en",
		"zh-CN",
	])("scope and site group stay in details, not the amount badge (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [{ id: "credit", unit: "USD", remaining: 1.2345, remainingText: "1.2345" }],
						windows: [],
						scope: "wallet",
						planName: "Site group",
					},
				}),
				translate,
			),
		);
		expect(formatQuotaBadgeText(view, translate)).toBe("USD 1.2345");
		expect(view.rows).toContainEqual({
			id: "meta/scope",
			label: translate("providerQuota.scope"),
			value: translate("providerQuota.scopes.wallet"),
		});
		expect(formatQuotaSummaryLines(view, 0, translate).join("\n")).toContain("Site group");
		expect(formatQuotaBadgeText(view, translate)).not.toContain(
			translate("providerQuota.scopes.wallet"),
		);
		const arbitrary = requireView(
			buildProviderQuotaView(
				snapshot({ data: { amounts: [], windows: [], scope: "Third-party scope" } }),
				translate,
			),
		);
		expect(arbitrary.rows).toContainEqual({
			id: "meta/scope",
			label: translate("providerQuota.scope"),
			value: "Third-party scope",
		});
	});

	test.each([
		"en",
		"zh-CN",
	])("auth_failed stays distinct and an empty authoritative error has no old values (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const failed = snapshot({ status: "error", error: "auth_failed", data: null });
		const view = requireView(buildProviderQuotaView(failed, translate, true));
		expect(view.rows).toEqual([]);
		expect(view.windows).toEqual([]);
		expect(view.failureDetail).toBe(translate("providerQuota.errors.auth_failed"));
		expect(view.failureDetail).not.toBe(translate("providerQuota.errors.request_failed"));
		expect(view.failureDetail).toContain("401/403");
		expect(buildProviderQuotaView(failed, translate, false)?.failureDetail).toBeNull();
	});

	test("exact reported decimals stay nonzero and invalid cached spellings never replace numbers", () => {
		expect(
			formatProviderQuotaAmount(
				{ id: "credit", unit: "USD", remaining: 0.0000000000004, remainingText: "0.0000000000004" },
				t,
			),
		).toBe("USD 0.0000000000004");
		expect(
			formatProviderQuotaAmount({ id: "credit", unit: "USD", remaining: 0, remainingText: "9" }, t),
		).toBe("USD 0");
	});

	test("locales omit plugin-unavailable hints but keep genuine error and account diagnostics", () => {
		for (const messages of [en, zh]) {
			expect(messages.providerQuota).not.toHaveProperty("unavailable");
			expect(messages.providerQuota.errors).not.toHaveProperty("unavailable");
			expect(messages.providerQuota.accountUnavailable).toBeTruthy();
			expect(messages.providerQuota.errors.request_failed).toBeTruthy();
			expect(messages.providerQuota.errors.permission_denied).toBeTruthy();
		}
	});
});

describe("normalized Custom API display identity and precedence", () => {
	test("account replacement or a different provider hides old snapshots immediately", () => {
		for (const identity of [
			{ providerId: "p1", generation: "account-B" },
			{ providerId: "p2", generation: "account-A" },
			{ providerId: "p1", generation: undefined },
		]) {
			expect(
				customApiQuotaDisplayFor({ ...identity, snapshot: snapshot() }).quotaSnapshot,
			).toBeNull();
		}
		expect(
			customApiQuotaDisplayFor({ providerId: "p1", generation: "account-A", snapshot: snapshot() })
				.quotaSnapshot?.data,
		).not.toBeNull();
	});
	test("pushed text including zero wins over every plugin status without rewriting snapshots", () => {
		for (const status of ["supported", "error", "unavailable", "probing"] as const) {
			const value = snapshot({ status });
			const display = customApiQuotaDisplayFor({
				providerId: "p1",
				generation: "account-A",
				pushedQuotas: { p1: { quotaBalance: "0", detailedQuotaBalance: "Live details" } },
				snapshot: value,
			});
			expect(display.pushedQuota?.quotaBalance).toBe("0");
			expect(display.quotaSnapshot).toBeNull();
			expect(value.data?.amounts[0]?.remaining).toBe(37.5);
		}
	});
	test("a pushed value explicitly tied to the old account cannot survive replacement", () => {
		const display = customApiQuotaDisplayFor({
			providerId: "p1",
			generation: "account-B",
			pushedQuotas: { p1: { generation: "account-A", quotaBalance: "Old private balance" } },
			snapshot: snapshot(),
		});
		expect(display).toEqual({ pushedQuota: null, quotaSnapshot: null });
	});
});
