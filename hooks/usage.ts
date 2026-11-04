import type { FableUsage } from "../types";

export const USAGE_REFRESH_MS = 300_000;
const FULL_PERCENT = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parseFableUsage = (
	text: string,
	fetchedAt: number,
): FableUsage | null => {
	if (!Number.isFinite(fetchedAt)) return null;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(data) || !Array.isArray(data.limits)) return null;
	const limits: readonly unknown[] = data.limits;
	for (const limit of limits) {
		if (!isRecord(limit) || limit.kind !== "weekly_scoped") continue;
		const { scope, percent, resets_at } = limit;
		if (
			!isRecord(scope) ||
			!isRecord(scope.model) ||
			typeof scope.model.display_name !== "string" ||
			scope.model.display_name.toLowerCase() !== "fable" ||
			typeof percent !== "number" ||
			!Number.isFinite(percent) ||
			percent < 0 ||
			percent > FULL_PERCENT ||
			(resets_at !== null && typeof resets_at !== "string")
		)
			continue;
		const resetsAt = resets_at === null ? null : Date.parse(resets_at);
		if (resetsAt !== null && !Number.isFinite(resetsAt)) continue;

		return { percentUsed: percent, resetsAt, fetchedAt };
	}

	return null;
};

export const fablePercent = (
	usage: FableUsage | null,
	now: number,
): number | undefined =>
	usage !== null &&
	Number.isFinite(now) &&
	now >= usage.fetchedAt &&
	now - usage.fetchedAt < USAGE_REFRESH_MS &&
	(usage.resetsAt === null || now < usage.resetsAt)
		? usage.percentUsed
		: undefined;
