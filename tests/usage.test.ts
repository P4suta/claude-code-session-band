import { expect, test } from "claude-code/testing";
import {
	fablePercent,
	parseFableUsage,
	USAGE_REFRESH_MS,
} from "../hooks/usage";
import type { FableUsage } from "../types";

const NOW = 1_700_000_000_000;
const row = (
	overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
	kind: "weekly_scoped",
	group: "weekly",
	percent: 62,
	resets_at: null,
	scope: { model: { display_name: "Fable" } },
	...overrides,
});
const parse = (limits: unknown): FableUsage | null =>
	parseFableUsage(JSON.stringify({ limits }), NOW);

test("only a Fable model-scoped weekly reading supplies its allowance", () => {
	expect(parse([row()])).toEqual({
		percentUsed: 62,
		resetsAt: null,
		fetchedAt: NOW,
	});
	for (const kind of [
		"session",
		"weekly_all",
		"five_hour",
		"seven_day",
		"spend_limit",
		"unknown",
	]) {
		expect(parse([row({ kind })])).toBeNull();
	}
	for (const display_name of ["Opus", "Sonnet", "Fable impostor", "", null]) {
		expect(parse([row({ scope: { model: { display_name } } })])).toBeNull();
	}
	expect(
		parse([row({ scope: { surface: { display_name: "Fable" } } })]),
	).toBeNull();
	expect(parse([row({ kind: "weekly_all" }), row()])?.percentUsed).toBe(62);
});

test("missing and malformed readings remain absent rather than zero", () => {
	for (const value of [
		null,
		{},
		[],
		"",
		42,
		{ limits: null },
		{ limits: [null, {}, 4] },
	]) {
		expect(parseFableUsage(JSON.stringify(value), NOW)).toBeNull();
	}
	expect(parseFableUsage("{", NOW)).toBeNull();
	for (const percent of [
		undefined,
		null,
		"0",
		-1,
		101,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		expect(parse([row({ percent })])).toBeNull();
	}
	for (const percent of [0, 0.5, 62, 100]) {
		expect(parse([row({ percent })])?.percentUsed).toBe(percent);
	}
	for (const resets_at of [undefined, "invalid", 42]) {
		expect(parse([row({ resets_at })])).toBeNull();
	}
});

test("a Fable reading expires at its reset or the refresh interval", () => {
	const resetsAt = NOW + 1000;
	const reading = parse([row({ resets_at: new Date(resetsAt).toISOString() })]);
	expect(fablePercent(reading, NOW)).toBe(62);
	expect(fablePercent(reading, resetsAt)).toBeUndefined();
	const unreset = parse([row({ percent: 0 })]);
	expect(fablePercent(unreset, NOW + USAGE_REFRESH_MS - 1)).toBe(0);
	expect(fablePercent(unreset, NOW + USAGE_REFRESH_MS)).toBeUndefined();
	expect(fablePercent(unreset, NOW - 1)).toBeUndefined();
	expect(fablePercent(null, NOW)).toBeUndefined();
});
