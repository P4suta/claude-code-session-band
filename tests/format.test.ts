import { expect, test } from "claude-code/testing";
import {
	bandSegments,
	CONTEXT_WARN_PERCENT,
	cells,
	clampPercent,
	endTurn,
	FOOTER_RESERVE,
	fitSegments,
	footerRoom,
	formatClock,
	formatSpan,
	formatUsd,
	gauge,
	gitLabel,
	ICON,
	layoutBand,
	MIN_PATH_CELLS,
	modelLabel,
	parseGitStatus,
	segmentCells,
	shortenPath,
	startTurn,
	tickBucket,
	tildePath,
	workAt,
} from "../hooks/format";
import type { WorkClock } from "../types";

// Bounded exhaustive checks over finite domains, and fixed-seed property checks elsewhere.
// Failures are collected and compared once, so a broken property reports its first counterexamples.

const HOURS_CHECKED = 100;

const mulberry32 = (seed: number) => {
	let a = seed >>> 0;
	return (): number => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const pick = <T>(random: () => number, items: readonly T[]): T => {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
};

const clockSeconds = (text: string): number | undefined => {
	const long = /^([1-9]\d*):([0-5]\d):([0-5]\d)$/.exec(text);
	if (long)
		return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]);
	const short = /^([1-5]?\d):([0-5]\d)$/.exec(text);
	if (short) return Number(short[1]) * 60 + Number(short[2]);
	return undefined;
};

const spanMinutes = (text: string): number | undefined => {
	const long = /^([1-9]\d*)h ([1-5]?\d)m$/.exec(text);
	if (long) return Number(long[1]) * 60 + Number(long[2]);
	const short = /^([1-5]?\d)m$/.exec(text);
	if (short) return Number(short[1]);
	return undefined;
};

test("formatClock and formatSpan rebuild every second up to 100 hours", () => {
	const bad: string[] = [];
	for (let s = 0; s < HOURS_CHECKED * 3600; s += 1) {
		for (const ms of [s * 1000, s * 1000 + 999]) {
			if (clockSeconds(formatClock(ms)) !== s) bad.push(`clock ${ms}`);
			if (spanMinutes(formatSpan(ms)) !== Math.floor(s / 60))
				bad.push(`span ${ms}`);
		}
	}
	expect(bad.slice(0, 5)).toEqual([]);
});

test("formatClock and formatSpan read invalid input as zero", () => {
	for (const ms of [-1, -1e12, Number.NaN, Number.NEGATIVE_INFINITY]) {
		expect(formatClock(ms)).toBe("0:00");
		expect(formatSpan(ms)).toBe("0m");
	}
	expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
	expect(clockSeconds(formatClock(Number.MAX_SAFE_INTEGER))).toBe(
		Math.floor(Number.MAX_SAFE_INTEGER / 1000),
	);
	expect(formatClock(1e300)).not.toContain("e");
});

test("clampPercent answers a whole percentage in range for every half step", () => {
	const bad: number[] = [];
	for (let i = -2000; i <= 2000; i += 1) {
		const x = i / 2;
		const p = clampPercent(x);
		const expected = Math.min(100, Math.max(0, Math.round(x)));
		if (p !== expected || !Number.isInteger(p) || p < 0 || p > 100) bad.push(x);
	}
	expect(bad.slice(0, 5)).toEqual([]);
	expect(clampPercent(undefined)).toBeUndefined();
	expect(clampPercent(Number.NaN)).toBeUndefined();
	expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(100);
	expect(clampPercent(Number.NEGATIVE_INFINITY)).toBe(0);
});

test("formatUsd shows cents and leaves out what is no cost", () => {
	expect(formatUsd(3.214)).toBe("$3.21");
	expect(formatUsd(0)).toBe("$0.00");
	expect(formatUsd(undefined)).toBeUndefined();
	expect(formatUsd(-1)).toBeUndefined();
	expect(formatUsd(Number.NaN)).toBeUndefined();
});

test("cells counts wide characters twice and marks as nothing", () => {
	expect(cells("abc")).toBe(3);
	expect(cells("日本語")).toBe(6);
	expect(cells("😀")).toBe(2);
	expect(cells("é")).toBe(1);
	expect(cells("")).toBe(0);
});

test("tildePath spells the home directory as ~", () => {
	expect(tildePath("/Users/me/work", "/Users/me")).toBe("~/work");
	expect(tildePath("/Users/me", "/Users/me/")).toBe("~");
	expect(tildePath("/Users/meow", "/Users/me")).toBe("/Users/meow");
	expect(tildePath("/tmp", undefined)).toBe("/tmp");
	expect(tildePath("/tmp", "/")).toBe("/tmp");
});

const PATH_PIECES = ["a", "src", "/", "/", "日本", "😀", "é", "projects", "x"];

test("shortenPath fits its cells and keeps a tail (10,000 seeded paths)", () => {
	const random = mulberry32(0x5eed);
	const bad: string[] = [];
	for (let i = 0; i < 10_000; i += 1) {
		const length = Math.floor(random() * 12);
		const path = Array.from({ length }, () => pick(random, PATH_PIECES)).join(
			"",
		);
		const max = Math.floor(random() * 50) - 2;
		const out = shortenPath(path, max);
		const fits = cells(path) <= max;
		const isTail =
			out === path ||
			(out === "" && max < 1) ||
			(out.startsWith("…") && path.endsWith(out.slice(1)));
		if (fits ? out !== path : cells(out) > Math.max(0, max) || !isTail)
			bad.push(JSON.stringify({ path, max, out }));
	}
	expect(bad.slice(0, 5)).toEqual([]);
	expect(shortenPath("~/projects/github.com/P4suta", 20)).toBe(
		"…/github.com/P4suta",
	);
});

test("fitSegments fits every width and drops only from the end", () => {
	const sets: { gap: number; cells: number }[][] = [
		[],
		[{ gap: 1, cells: 14 }],
		[
			{ gap: 1, cells: 8 },
			{ gap: 3, cells: 15 },
			{ gap: 3, cells: 14 },
			{ gap: 3, cells: 11 },
			{ gap: 3, cells: 9 },
			{ gap: 3, cells: 5 },
			{ gap: 3, cells: 12 },
		],
		[
			{ gap: 3, cells: 0 },
			{ gap: 0, cells: 0 },
			{ gap: 3, cells: 40 },
		],
	];
	const bad: string[] = [];
	for (const segments of sets) {
		for (const pathCells of [0, 5, MIN_PATH_CELLS, 40, 200]) {
			for (let width = -5; width <= 300; width += 1) {
				const fit = fitSegments(pathCells, segments, width);
				const kept = segments.slice(0, fit.kept);
				const used = kept.reduce((n, s) => n + s.gap + s.cells, 0);
				const room = Math.max(0, width);
				const floor = Math.min(pathCells, MIN_PATH_CELLS);
				const next = segments[fit.kept];
				const isMaximal =
					next === undefined ||
					floor > room ||
					floor + used + next.gap + next.cells > room;
				const isPathWhole = fit.pathCells === Math.min(pathCells, room - used);
				if (
					fit.pathCells + used > room ||
					fit.pathCells < 0 ||
					fit.pathCells > pathCells ||
					!isMaximal ||
					!isPathWhole
				)
					bad.push(JSON.stringify({ segments, pathCells, width, fit }));
			}
		}
	}
	expect(bad.slice(0, 5)).toEqual([]);
});

const BRANCHES = ["main", "feat/band", "release-1.2", "日本語"];

test("parseGitStatus reads what git writes (10,000 seeded outputs)", () => {
	const random = mulberry32(0x917);
	const bad: string[] = [];
	for (let i = 0; i < 10_000; i += 1) {
		const isDetached = random() < 0.2;
		const branch = pick(random, BRANCHES);
		const oid = "0123456789abcdef0123456789abcdef01234567";
		const ahead = Math.floor(random() * 5);
		const behind = Math.floor(random() * 5);
		const hasUpstream = random() < 0.7;
		const changes = Math.floor(random() * 6);
		const lines = [
			`# branch.oid ${oid}`,
			`# branch.head ${isDetached ? "(detached)" : branch}`,
			...(hasUpstream
				? [
						`# branch.upstream origin/${branch}`,
						`# branch.ab +${ahead} -${behind}`,
					]
				: []),
			...Array.from(
				{ length: changes },
				(_, n) => `${pick(random, ["1", "2", "u"])} .M N... 100644 file${n}`,
			),
		];
		const parsed = parseGitStatus(`${lines.join("\n")}\n`);
		const expected = {
			branch: isDetached ? "0123456" : branch,
			changes,
			ahead: hasUpstream ? ahead : 0,
			behind: hasUpstream ? behind : 0,
		};
		if (JSON.stringify(parsed) !== JSON.stringify(expected))
			bad.push(JSON.stringify({ lines, parsed }));
	}
	expect(bad.slice(0, 5)).toEqual([]);
	expect(parseGitStatus("")).toBeNull();
	expect(parseGitStatus("fatal: not a git repository")).toBeNull();
	expect(parseGitStatus("# branch.head (detached)\n")?.branch).toBe("detached");
});

test("gitLabel names the branch and what moved", () => {
	expect(gitLabel({ branch: "main", changes: 0, ahead: 0, behind: 0 })).toBe(
		"main",
	);
	expect(gitLabel({ branch: "main", changes: 3, ahead: 1, behind: 2 })).toBe(
		"main ±3 ↑1 ↓2",
	);
});

test("the work clock adds main-loop turns and starts over with the session (10,000 seeded runs)", () => {
	const random = mulberry32(0xc10c);
	const bad: string[] = [];
	for (let run = 0; run < 10_000; run += 1) {
		let clock: WorkClock | null = null;
		let session = 1000;
		let now = session;
		let total = 0;
		let runningSince: number | null = null;
		for (let step = 0; step < 8; step += 1) {
			const roll = random();
			now += Math.floor(random() * 100_000);
			if (roll < 0.1 && runningSince === null) {
				session = now;
				total = 0;
			} else if (runningSince === null) {
				clock = startTurn(clock, session, now);
				runningSince = now;
			} else {
				const duration = now - runningSince;
				clock = endTurn(clock, session, duration);
				total += duration;
				runningSince = null;
			}
			const seen = workAt(clock, session, now);
			const turnMs = runningSince === null ? null : now - runningSince;
			if (seen.turnMs !== turnMs || seen.totalMs !== total + (turnMs ?? 0))
				bad.push(JSON.stringify({ run, step, clock, seen, total }));
		}
	}
	expect(bad.slice(0, 5)).toEqual([]);
	expect(endTurn(null, 0, Number.NaN).totalMs).toBe(0);
	expect(endTurn(null, 0, -5).totalMs).toBe(0);
});

test("tickBucket moves each second while working and each elapsed minute while idle", () => {
	const started = 1_700_000_000_000;
	const bad: number[] = [];
	for (let s = 1; s <= 2 * 3600; s += 1) {
		const now = started + s * 1000;
		const before = now - 1000;
		const working = tickBucket(true, started, now);
		const idle = tickBucket(false, started, now);
		if (working === tickBucket(true, started, before)) bad.push(s);
		if ((idle !== tickBucket(false, started, before)) !== (s % 60 === 0))
			bad.push(-s);
		if (working === idle) bad.push(s);
	}
	expect(bad.slice(0, 5)).toEqual([]);
});

const FACTS = {
	git: { branch: "main", changes: 2, ahead: 1, behind: 0 },
	model: "claude-opus-5-5",
	sessionMs: 65 * 60_000,
	contextPercent: 42,
	work: { totalMs: 18 * 60_000 + 2000, turnMs: null },
	usd: 3.214,
	fiveHourPercent: 37,
} as const;

const shown = (facts: Parameters<typeof bandSegments>[0]): string =>
	bandSegments(facts)
		.map((s) => s.gap + s.parts.map((p) => p.text).join(""))
		.join("");

test("layoutBand keeps the lowest ranks in drawing order at every width", () => {
	const variants = [
		FACTS,
		{ ...FACTS, git: null },
		{ ...FACTS, contextPercent: 91, work: { totalMs: 0, turnMs: 5000 } },
		{ ...FACTS, usd: undefined, fiveHourPercent: undefined },
	];
	const bad: string[] = [];
	for (const facts of variants) {
		const segments = bandSegments(facts);
		const ranks = segments.map((s) => s.rank).sort((a, b) => a - b);
		for (const pathCells of [0, 15, 40]) {
			for (let width = -5; width <= 300; width += 1) {
				const layout = layoutBand(pathCells, segments, width);
				const order = layout.shown.map((s) => segments.indexOf(s));
				const isInOrder = order.every(
					(i, n) => n === 0 || i > (order[n - 1] ?? -1),
				);
				const shownRanks = layout.shown
					.map((s) => s.rank)
					.sort((a, b) => a - b);
				const isLowest =
					JSON.stringify(shownRanks) ===
					JSON.stringify(ranks.slice(0, shownRanks.length));
				const used = layout.shown
					.map(segmentCells)
					.reduce((n, s) => n + s.gap + s.cells, 0);
				if (
					!isInOrder ||
					!isLowest ||
					layout.pathCells + used > Math.max(0, width)
				)
					bad.push(JSON.stringify({ facts, pathCells, width, order }));
			}
		}
	}
	expect(bad.slice(0, 5)).toEqual([]);
});

test("bandSegments draws every fact in drawing order, each after its icon", () => {
	expect(shown(FACTS)).toBe(
		[
			`  ${ICON.branch} main ±2 ↑1`,
			`  ${ICON.model} Opus 5.5`,
			`  ${ICON.session} 1h 5m`,
			`  ${ICON.work} 18:02`,
			`  ${ICON.context} ▕███▍    ▏42%`,
			`  ${ICON.cost} $3.21`,
			`  ${ICON.limit} 5h▕███     ▏37%`,
		].join(""),
	);
	expect(
		shown({
			...FACTS,
			git: null,
			contextPercent: undefined,
			usd: undefined,
			fiveHourPercent: undefined,
		}),
	).toBe(`  ${ICON.model} Opus 5.5  ${ICON.session} 1h 5m  ${ICON.work} 18:02`);
});

test("bandSegments marks a full context and a running turn by weight and inversion", () => {
	const parts = (facts: Parameters<typeof bandSegments>[0]) =>
		bandSegments(facts).flatMap((s) => s.parts);

	const full = parts({ ...FACTS, contextPercent: CONTEXT_WARN_PERCENT });
	expect(full.find((p) => p.text.endsWith("compact soon"))).toEqual({
		text: `${CONTEXT_WARN_PERCENT}% compact soon`,
		isBold: true,
		isInverse: true,
	});
	const calm = parts({ ...FACTS, contextPercent: CONTEXT_WARN_PERCENT - 1 });
	expect(calm.some((p) => p.isInverse === true)).toBe(false);
	expect(calm.some((p) => p.text.includes("compact soon"))).toBe(false);

	const running = parts({
		...FACTS,
		work: { totalMs: 60_000, turnMs: 42_000 },
	});
	expect(running.find((p) => p.text.includes(ICON.turn))).toEqual({
		text: ` ${ICON.turn} 0:42`,
		isBold: true,
	});
});

test("gauge fills its frame to the nearest eighth for every half percent and width", () => {
	const bad: string[] = [];
	for (let width = 0; width <= 20; width += 1) {
		let last = -1;
		for (let i = 0; i <= 200; i += 1) {
			const percent = i / 2;
			const bar = gauge(percent, width);
			const inner = bar.slice(1, -1);
			const eighths = Array.from(inner).reduce(
				(n, ch) => n + (ch === "█" ? 8 : "▏▎▍▌▋▊▉".indexOf(ch) + 1),
				0,
			);
			const expected = Math.round(
				((clampPercent(percent) ?? 0) / 100) * width * 8,
			);
			if (
				!bar.startsWith("▕") ||
				!bar.endsWith("▏") ||
				cells(inner) !== width ||
				eighths !== expected ||
				eighths < last
			)
				bad.push(JSON.stringify({ width, percent, bar }));
			last = eighths;
		}
	}
	expect(bad.slice(0, 5)).toEqual([]);
	expect(gauge(Number.NaN, 4)).toBe("▕    ▏");
	expect(gauge(500, 2)).toBe("▕██▏");
});

test("footerRoom leaves the hint and the reserve out for every width up to 400", () => {
	const bad: string[] = [];
	for (let columns = -5; columns <= 400; columns += 1) {
		for (let hintCells = -5; hintCells <= 120; hintCells += 1) {
			const room = footerRoom(columns, hintCells);
			const expected = Math.max(
				0,
				columns - Math.max(0, hintCells) - FOOTER_RESERVE,
			);
			if (room !== expected) bad.push(JSON.stringify({ columns, hintCells }));
		}
	}
	expect(bad.slice(0, 5)).toEqual([]);
});

test("modelLabel names the family and version", () => {
	expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
	expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
	expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
	expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5[1m]");
	expect(modelLabel("Opus 5.5")).toBe("Opus 5.5");
	expect(modelLabel("")).toBe("");
});
