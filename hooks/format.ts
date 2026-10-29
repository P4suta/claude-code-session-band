import type { GitInfo, WorkClock } from "../types";

// Pure core of the band: formatting, layout and the work clock's transitions.

export const MIN_PATH_CELLS = 12;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
// Minutes and seconds after a larger field are written with two digits.
const FIELD_DIGITS = 2;
const FULL_PERCENT = 100;
const CENT_DIGITS = 2;

const wholeSeconds = (ms: number): number =>
	Number.isFinite(ms) && ms > 0
		? Math.floor(Math.min(ms, Number.MAX_SAFE_INTEGER) / MS_PER_SECOND)
		: 0;

const pad = (n: number): string => String(n).padStart(FIELD_DIGITS, "0");

/** `m:ss` under an hour, `h:mm:ss` from one; negative or non-finite is zero. */
export const formatClock = (ms: number): string => {
	const total = wholeSeconds(ms);
	const h = Math.floor(total / SECONDS_PER_HOUR);
	const m = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	const s = total % SECONDS_PER_MINUTE;

	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

/** Whole minutes: `Xm` under an hour, `Xh Ym` from one. */
export const formatSpan = (ms: number): string => {
	const minutes = Math.floor(wholeSeconds(ms) / SECONDS_PER_MINUTE);
	const h = Math.floor(minutes / MINUTES_PER_HOUR);
	const m = minutes % MINUTES_PER_HOUR;

	return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/** A whole percentage in [0, 100]; no reading stays no reading. */
export const clampPercent = (x: number | undefined): number | undefined =>
	x === undefined || Number.isNaN(x)
		? undefined
		: Math.min(FULL_PERCENT, Math.max(0, Math.round(x)));

export const formatUsd = (usd: number | undefined): string | undefined =>
	usd === undefined || !Number.isFinite(usd) || usd < 0
		? undefined
		: `$${usd.toFixed(CENT_DIGITS)}`;

type CodeRange = readonly [first: number, last: number];

// Code points a terminal draws two cells wide: Hangul, CJK, fullwidth forms, and emoji.
// U+303F, the ideographic half fill space, is narrow inside the CJK block.
const WIDE: readonly CodeRange[] = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3040, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1faff],
	[0x20000, 0x3fffd],
];

// Combining marks, zero-width spaces and joiners, and variation selectors.
const ZERO_WIDTH: readonly CodeRange[] = [
	[0x0300, 0x036f],
	[0x200b, 0x200f],
	[0xfe00, 0xfe0f],
];

const WIDE_CELLS = 2;

const within = (ranges: readonly CodeRange[], cp: number): boolean =>
	ranges.some(([first, last]) => cp >= first && cp <= last);

const cellsOf = (cp: number): number =>
	within(ZERO_WIDTH, cp) ? 0 : within(WIDE, cp) ? WIDE_CELLS : 1;

/** Terminal cells a text takes: wide CJK and emoji count two. */
export const cells = (text: string): number => {
	let n = 0;
	for (const ch of text) n += cellsOf(ch.codePointAt(0) ?? 0);

	return n;
};

/** The path with the home directory spelled `~`. */
export const tildePath = (path: string, home: string | undefined): string => {
	const root = home?.replace(/\/+$/, "");
	if (root === undefined || root === "") return path;
	if (path === root) return "~";

	return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
};

/**
 * The path within `max` cells: whole when it fits, else `…` and its longest fitting tail.
 * The tail is cut at its first `/` past its start when it holds one.
 */
export const shortenPath = (path: string, max: number): string => {
	if (cells(path) <= max) return path;
	if (max < 1) return "";

	const points = Array.from(path);
	let room = max - 1;
	let start = points.length;
	while (start > 0) {
		const w = cellsOf(points[start - 1]?.codePointAt(0) ?? 0);
		if (w > room) break;
		room -= w;
		start -= 1;
	}
	const tail = points.slice(start).join("");
	const slash = tail.indexOf("/");

	return `…${slash > 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`;
};

const BRANCH_HEAD = "# branch.head ";
const BRANCH_OID = "# branch.oid ";
const BRANCH_AB = "# branch.ab ";
// A detached head is named by its object id's first digits, as `git log --oneline` names it.
const SHORT_OID_DIGITS = 7;

/** Reads `git status --porcelain=v2 --branch`; null when it names no head. */
export const parseGitStatus = (text: string): GitInfo | null => {
	let head: string | undefined;
	let oid: string | undefined;
	let ahead = 0;
	let behind = 0;
	let changes = 0;

	for (const line of text.split("\n")) {
		if (line.startsWith(BRANCH_HEAD))
			head = line.slice(BRANCH_HEAD.length).trim();
		else if (line.startsWith(BRANCH_OID))
			oid = line.slice(BRANCH_OID.length).trim();
		else if (line.startsWith(BRANCH_AB)) {
			const counts = /^\+(?<ahead>\d+) -(?<behind>\d+)$/.exec(
				line.slice(BRANCH_AB.length).trim(),
			)?.groups;
			ahead = Number(counts?.ahead ?? 0);
			behind = Number(counts?.behind ?? 0);
		} else if (/^[12u?] /.test(line)) changes += 1;
	}

	if (head === undefined || head === "") return null;
	const branch =
		head === "(detached)"
			? oid !== undefined && /^[0-9a-f]{7,}$/.test(oid)
				? oid.slice(0, SHORT_OID_DIGITS)
				: "detached"
			: head;

	return { branch, changes, ahead, behind };
};

export type Fit = { pathCells: number; kept: number };

/**
 * Lays the band out in `width` cells.
 * The path keeps up to MIN_PATH_CELLS before any segment.
 * Segments, each `gap + cells` wide and in priority order, are kept while they fit.
 * The path then takes what is left.
 */
export const fitSegments = (
	pathCells: number,
	segments: readonly { gap: number; cells: number }[],
	width: number,
): Fit => {
	const room = Math.max(0, width);
	const floor = Math.min(pathCells, MIN_PATH_CELLS);
	let used = 0;
	let kept = 0;

	if (floor <= room) {
		for (const segment of segments) {
			if (floor + used + segment.gap + segment.cells > room) break;
			used += segment.gap + segment.cells;
			kept += 1;
		}
	}

	return { pathCells: Math.max(0, Math.min(pathCells, room - used)), kept };
};

const fresh = (sessionStartedAt: number): WorkClock => ({
	sessionStartedAt,
	totalMs: 0,
	runningSince: null,
});

// A clock kept for another session (before a /clear) starts over.
const current = (
	work: WorkClock | null,
	sessionStartedAt: number,
): WorkClock =>
	work !== null && work.sessionStartedAt === sessionStartedAt
		? work
		: fresh(sessionStartedAt);

const nonNegative = (ms: number): number =>
	Number.isFinite(ms) && ms > 0 ? ms : 0;

export const startTurn = (
	work: WorkClock | null,
	sessionStartedAt: number,
	now: number,
): WorkClock => ({ ...current(work, sessionStartedAt), runningSince: now });

export const endTurn = (
	work: WorkClock | null,
	sessionStartedAt: number,
	durationMs: number,
): WorkClock => {
	const base = current(work, sessionStartedAt);

	return {
		...base,
		totalMs: base.totalMs + nonNegative(durationMs),
		runningSince: null,
	};
};

/** Work so far, the running turn included, and that turn's own time. */
export const workAt = (
	work: WorkClock | null,
	sessionStartedAt: number,
	now: number,
): { totalMs: number; turnMs: number | null } => {
	const base = current(work, sessionStartedAt);
	if (base.runningSince === null)
		return { totalMs: base.totalMs, turnMs: null };
	const turnMs = nonNegative(now - base.runningSince);

	return { totalMs: base.totalMs + turnMs, turnMs };
};

/** What the timer redraws on: each second while a turn runs, else each minute. */
export const tickBucket = (
	isWorking: boolean,
	sessionStartedAt: number,
	now: number,
): number =>
	isWorking
		? Math.floor(now / MS_PER_SECOND)
		: -1 - Math.floor(nonNegative(now - sessionStartedAt) / MS_PER_MINUTE);

export const GAP = "  ";
// Cells the footer keeps for its padding and the gap beside the hint line.
export const FOOTER_RESERVE = 6;

/** Cells left for the band at the right of a footer row beside a hint. */
export const footerRoom = (columns: number, hintCells: number): number =>
	Math.max(0, Math.floor(columns) - Math.max(0, hintCells) - FOOTER_RESERVE);
export const CONTEXT_WARN_PERCENT = 80;
export const GAUGE_CELLS = 8;

// Nerd Font glyphs, each drawn in one cell and followed by a space.
export const ICON = {
	directory: "",
	branch: "",
	model: "",
	session: "",
	work: "",
	turn: "",
	context: "",
	cost: "",
	limit: "",
} as const;

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * A framed bar of `width` cells inside the frame, filled to `percent` in eighths of a cell.
 * The fill rounds to the nearest eighth and stays within the frame.
 */
export const gauge = (percent: number, width: number): string => {
	const inner = Math.max(0, Math.floor(width));
	const total = inner * EIGHTHS.length;
	const filled = Math.min(
		total,
		Math.max(
			0,
			Math.round(((clampPercent(percent) ?? 0) / FULL_PERCENT) * total),
		),
	);
	const full = Math.floor(filled / EIGHTHS.length);
	const partial = EIGHTHS[filled % EIGHTHS.length] ?? "";
	const bar = "█".repeat(full) + partial;

	return `▕${bar}${" ".repeat(inner - cells(bar))}▏`;
};

/** `claude-opus-5-5` as `Opus 5.5`; an id of another shape stays as it is. */
export const modelLabel = (id: string): string => {
	const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(.*)$/.exec(id);
	if (!match) return id;
	const [, family = "", major, minor, rest] = match;

	return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}${rest}`;
};

// Which fact gives way first when the band is narrow: the highest rank.
const RANK = {
	model: 0,
	session: 1,
	context: 2,
	work: 3,
	git: 4,
	cost: 5,
	limit: 6,
} as const;

export type Part = { text: string; isBold?: boolean; isInverse?: boolean };
export type Segment = { rank: number; gap: string; parts: readonly Part[] };

export type BandFacts = {
	git: GitInfo | null;
	model: string;
	sessionMs: number;
	contextPercent: number | undefined;
	work: { totalMs: number; turnMs: number | null };
	usd: number | undefined;
	fiveHourPercent: number | undefined;
};

export const gitLabel = (info: GitInfo): string => {
	const marks = [
		info.changes > 0 ? `±${info.changes}` : "",
		info.ahead > 0 ? `↑${info.ahead}` : "",
		info.behind > 0 ? `↓${info.behind}` : "",
	].filter((mark) => mark !== "");

	return [info.branch, ...marks].join(" ");
};

const icon = (glyph: string): Part => ({ text: `${glyph} ` });

/** The segments after the path, in the order drawn. */
export const bandSegments = (facts: BandFacts): Segment[] => {
	const segments: Segment[] = [];
	const push = (rank: number, ...parts: Part[]) =>
		segments.push({ rank, gap: GAP, parts });

	if (facts.git !== null)
		push(RANK.git, icon(ICON.branch), { text: gitLabel(facts.git) });
	push(RANK.model, icon(ICON.model), { text: modelLabel(facts.model) });
	push(RANK.session, icon(ICON.session), {
		text: formatSpan(facts.sessionMs),
	});

	const total = { text: formatClock(facts.work.totalMs) };
	if (facts.work.turnMs === null) push(RANK.work, icon(ICON.work), total);
	else
		push(RANK.work, icon(ICON.work), total, {
			text: ` ${ICON.turn} ${formatClock(facts.work.turnMs)}`,
			isBold: true,
		});

	const context = clampPercent(facts.contextPercent);
	if (context !== undefined && context >= CONTEXT_WARN_PERCENT)
		push(
			RANK.context,
			icon(ICON.context),
			{ text: gauge(context, GAUGE_CELLS), isBold: true },
			{ text: `${context}% compact soon`, isBold: true, isInverse: true },
		);
	else if (context !== undefined)
		push(RANK.context, icon(ICON.context), {
			text: `${gauge(context, GAUGE_CELLS)}${context}%`,
		});

	const usd = formatUsd(facts.usd);
	if (usd !== undefined) push(RANK.cost, icon(ICON.cost), { text: usd });

	const limit = clampPercent(facts.fiveHourPercent);
	if (limit !== undefined)
		push(RANK.limit, icon(ICON.limit), {
			text: `5h${gauge(limit, GAUGE_CELLS)}${limit}%`,
		});

	return segments;
};

export const segmentCells = (
	segment: Segment,
): { gap: number; cells: number } => ({
	gap: cells(segment.gap),
	cells: segment.parts.reduce((n, part) => n + cells(part.text), 0),
});

/**
 * The band in `width` cells: fitSegments by rank, the kept segments in drawing order.
 */
export const layoutBand = (
	pathCells: number,
	segments: readonly Segment[],
	width: number,
): { pathCells: number; shown: Segment[] } => {
	const byRank = [...segments].sort((a, b) => a.rank - b.rank);
	const fit = fitSegments(pathCells, byRank.map(segmentCells), width);
	const kept = new Set(byRank.slice(0, fit.kept));

	return {
		pathCells: fit.pathCells,
		shown: segments.filter((segment) => kept.has(segment)),
	};
};
