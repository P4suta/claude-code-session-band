import type {
	HttpResponse,
	On,
	SessionAuthorization,
	SessionUsage,
} from "claude-code";
import { expect, mock, test } from "claude-code/testing";

import { cells, FOOTER_RESERVE, footerRoom, ICON } from "../hooks/format";
import { USAGE_REFRESH_MS } from "../hooks/usage";

const STARTED = 1_700_000_000_000;

// The footer's mode labels, in a terminal that leaves the band `room` cells.
const band = (room: number, modes: readonly string[] = []) =>
	({
		plugin: "session-band",
		component: "SessionMode",
		requestId: "modes",
		props: { modes },
		viewport: { columns: room + FOOTER_RESERVE, rows: 40 },
	}) as const;

const hint = (text: string) =>
	({
		plugin: "session-band",
		component: "PromptHint",
		requestId: "hint",
		props: { isDraft: false, isWorking: false, hint: text },
	}) as const;

const above = (bodyColumns: number, hasSurvey = false) =>
	({
		plugin: "session-band",
		component: "AbovePrompt",
		requestId: "band",
		props: {
			hasSurvey,
			isWorking: false,
			maxRows: 10,
			bodyColumns,
			scroll: { offset: 0, bodyRows: 10 },
			view: {},
		},
	}) as const;

const GIT_OUTPUT = [
	"# branch.oid 0123456789abcdef0123456789abcdef01234567",
	"# branch.head main",
	"# branch.upstream origin/main",
	"# branch.ab +1 -0",
	"1 .M N... 100644 100644 100644 a a hooks/format.ts",
	"1 M. N... 100644 100644 100644 b b hooks/register.tsx",
	"",
].join("\n");

// Nothing sits beneath the plugin: each hook here stands for the engine.
const engine = (
	on: On,
	{
		usage = {},
		git = { exitCode: 0, stdout: GIT_OUTPUT },
		authorization = null,
	}: {
		usage?: Partial<SessionUsage>;
		git?: { exitCode: number; stdout: string };
		authorization?: SessionAuthorization;
	} = {},
) => {
	const clock = mock.clock(on, { now: STARTED + 65 * 60_000 });
	mock.env(on, { HOME: "/Users/me" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	on("session.end", (_, e) => ({ sessionId: e.sessionId }));
	on("session.cwd", () => ({ value: "/Users/me/projects/demo" }));
	on("session.model", () => ({ value: "claude-opus-5-5" }));
	on("session.usage", () => ({
		value: {
			startedAt: STARTED,
			context: { tokens: 84_000, window: 200_000, percent: 42 },
			rateLimits: [
				{ kind: "five_hour", percentUsed: 88 },
				{ kind: "seven_day", percentUsed: 37 },
				{ kind: "spend_limit", percentUsed: 99 },
			],
			cost: { usd: 3.214 },
			...usage,
		},
	}));
	on("session.authorize", () => ({ value: authorization }));
	on("process.run", () => ({
		value: {
			...git,
			stderr: "",
			isStdoutTruncated: false,
			isStderrTruncated: false,
		},
	}));
	on("turn.start", (_, e) => ({ turnId: e.turnId }));
	on("turn.complete", () => ({ text: "" }));
	on("ui.render", ($, e) => {
		const { Text } = $.ui.resolve(e);

		return <Text>engine</Text>;
	});

	return clock;
};

const textOf = (node: unknown): string => {
	if (typeof node === "string") return node;
	if (typeof node !== "object" || node === null) return "";
	const { children, props } = node as {
		children?: unknown;
		props?: { children?: unknown };
	};
	const kids = children ?? props?.children;

	return Array.isArray(kids) ? kids.map(textOf).join("") : textOf(kids);
};

const SURFACES = ["terminal", "desktop"] as const;

const accountUsage = (percent: number): HttpResponse => ({
	ok: true,
	status: 200,
	headers: {},
	text: JSON.stringify({
		limits: [
			{
				kind: "weekly_scoped",
				percent,
				resets_at: null,
				scope: { model: { display_name: "Fable" } },
			},
		],
	}),
});

test("the band shows every fact when there is room, on every surface", async ($, on) => {
	const clock = engine(on);
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();

	for (const surface of SURFACES) {
		const ui = await $.ui.mount({ ...band(200), surface });
		expect(textOf(await ui.drawn())).toBe(
			[
				`${ICON.directory} ~/projects/demo`,
				`  ${ICON.branch} main ±2 ↑1`,
				`  ${ICON.model} Opus 5.5`,
				`  ${ICON.session} 1h 5m`,
				`  ${ICON.work} 0:00`,
				`  ${ICON.context} ▕███▍    ▏42%`,
				`  ${ICON.cost} $3.21`,
				`  ${ICON.limit} 7d▕███     ▏37%`,
			].join(""),
		);
		const path = await ui.find({ type: "Text", text: /^~\/projects\/demo$/ });
		expect(path?.props.weight).toBe("bold");
		await ui.unmount();
	}
});

test("the band reads the Fable allowance separately from the current model and weekly window", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "bearer", handle: "test-credential" },
	});
	let requests = 0;
	on("http.fetch", (_, e) => {
		requests += 1;
		expect(e.url).toBe("https://api.anthropic.com/api/oauth/usage");
		expect(e.init?.auth).toBe("test-credential");
		expect(e.init?.headers).toEqual({ "anthropic-beta": "oauth-2025-04-20" });
		return { value: accountUsage(62) };
	});
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();

	for (const surface of SURFACES) {
		const ui = await $.ui.mount({ ...band(200), surface });
		const text = textOf(await ui.drawn());
		expect(text).toContain("Opus 5.5");
		expect(text).toContain("7d▕███     ▏37%");
		expect(text).toContain("Fable▕█████   ▏62%");
		expect(text).not.toContain("5h");
		await ui.unmount();
	}
	expect(requests).toBe(1);
});

test("API-key sessions never request subscription usage", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "api-key", handle: "test-api-key" },
	});
	let requests = 0;
	on("http.fetch", () => {
		requests += 1;
		return { value: accountUsage(62) };
	});
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	expect(requests).toBe(0);
	await ui.unmount();
});

test("the Fable reading refreshes every five minutes and clears after a failed refresh", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "bearer", handle: "test-credential" },
	});
	let requests = 0;
	on("http.fetch", () => {
		requests += 1;
		return {
			value:
				requests < 3
					? accountUsage(requests === 1 ? 0 : 62)
					: { ok: false, status: 429, headers: {}, text: "rate limited" },
		};
	});
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	expect(textOf(await ui.drawn())).toContain("Fable▕        ▏0%");
	await clock.advance(USAGE_REFRESH_MS - 1);
	expect(requests).toBe(1);
	await clock.advance(1);
	expect(requests).toBe(2);
	expect(textOf(await ui.drawn())).toContain("Fable▕█████   ▏62%");
	await clock.advance(USAGE_REFRESH_MS);
	expect(requests).toBe(3);
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	expect(textOf(await ui.drawn())).toContain("7d");
	await ui.unmount();
});

test("slow usage requests neither block rendering nor overlap", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "bearer", handle: "test-credential" },
	});
	let requests = 0;
	let complete: ((response: HttpResponse) => void) | undefined;
	on("http.fetch", async () => {
		requests += 1;
		const response = await new Promise<HttpResponse>((resolve) => {
			complete = resolve;
		});

		return { value: response };
	});
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	expect(textOf(await ui.drawn())).toContain("7d");
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	await clock.advance(USAGE_REFRESH_MS);
	expect(requests).toBe(1);
	complete?.(accountUsage(62));
	await clock.settle();
	expect(textOf(await ui.drawn())).toContain("Fable");
	await ui.unmount();
});

test("clearing or resuming a conversation keeps account usage polling", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "bearer", handle: "test-credential" },
	});
	let requests = 0;
	on("http.fetch", () => ({ value: accountUsage(++requests) }));
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	for (const reason of ["clear", "resume"] as const) {
		await $.session.end({
			reason,
			sessionId: "test-session",
			resume: { id: "test-session" },
		});
		await clock.advance(USAGE_REFRESH_MS);
		expect(textOf(await ui.drawn())).toContain("Fable");
	}
	expect(requests).toBe(3);
	await $.session.end({
		reason: "logout",
		sessionId: "test-session",
		resume: { id: "test-session" },
	});
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	await ui.unmount();
});

test("logout discards an in-flight account reading and polling can use the next login", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "bearer", handle: "test-credential" },
	});
	let complete: ((response: HttpResponse) => void) | undefined;
	let requests = 0;
	on("http.fetch", async () => {
		requests += 1;
		const response =
			requests === 1
				? await new Promise<HttpResponse>((resolve) => {
						complete = resolve;
					})
				: accountUsage(62);

		return { value: response };
	});
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	await $.session.end({
		reason: "logout",
		sessionId: "test-session",
		resume: { id: "test-session" },
	});
	complete?.(accountUsage(100));
	await clock.settle();
	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	await clock.advance(USAGE_REFRESH_MS);
	expect(textOf(await ui.drawn())).toContain("Fable▕█████   ▏62%");
	expect(requests).toBe(2);
	await ui.unmount();
});

test("malformed responses and transport failures leave Fable usage absent", async ($, on) => {
	const clock = engine(on, {
		authorization: { kind: "bearer", handle: "test-credential" },
	});
	let requests = 0;
	on("http.fetch", () => {
		requests += 1;
		if (requests === 2) throw new Error("offline");

		return { value: { ok: true, status: 200, headers: {}, text: "{" } };
	});
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	await clock.advance(USAGE_REFRESH_MS);
	expect(textOf(await ui.drawn())).not.toContain("Fable");
	expect(requests).toBe(2);
	await ui.unmount();
});

test("a narrow band drops the least important facts first", async ($, on) => {
	const clock = engine(on);
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();

	for (const surface of SURFACES) {
		for (const width of [20, 40, 60, 80]) {
			const ui = await $.ui.mount({ ...band(width), surface });
			const text = textOf(await ui.drawn());
			expect(cells(text)).toBeLessThanOrEqual(width);
			expect(text).not.toContain(ICON.limit);
			if (width >= 40) expect(text).toContain("Opus 5.5");
			await ui.unmount();
		}

		const ui = await $.ui.mount({ ...band(80), surface });
		expect(textOf(await ui.drawn())).toBe(
			[
				`${ICON.directory} ~/projects/demo`,
				`  ${ICON.branch} main ±2 ↑1`,
				`  ${ICON.model} Opus 5.5`,
				`  ${ICON.session} 1h 5m`,
				`  ${ICON.work} 0:00`,
				`  ${ICON.context} ▕███▍    ▏42%`,
			].join(""),
		);
		await ui.unmount();
	}
});

test("the band leaves the footer room for the hint line beside it", async ($, on) => {
	const clock = engine(on);
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();
	const line = "⏵⏵ bypass permissions on (shift+tab to cycle)";

	for (const surface of SURFACES) {
		const shown = await $.ui.mount({ ...hint(line), surface });
		expect(textOf(await shown.drawn())).toBe("engine");
		await clock.settle();

		const columns = 120;
		const ui = await $.ui.mount({
			...band(columns - FOOTER_RESERVE),
			surface,
		});
		const text = textOf(await ui.drawn());
		expect(cells(text)).toBeLessThanOrEqual(footerRoom(columns, cells(line)));
		expect(text).toContain("Opus 5.5");
		expect(text).not.toContain(ICON.limit);
		await ui.unmount();
		await shown.unmount();
	}
});

test("the band sits above the prompt until the footer draws it", async ($, on) => {
	const clock = engine(on);

	const before = await $.ui.mount({ ...above(200), surface: "terminal" });
	expect(textOf(await before.drawn())).toContain(`${ICON.model} Opus 5.5`);
	await before.unmount();

	const survey = await $.ui.mount({ ...above(200, true), surface: "terminal" });
	expect(textOf(await survey.drawn())).toBe("engine");
	await survey.unmount();

	const footer = await $.ui.mount({ ...band(200), surface: "terminal" });
	await clock.settle();
	const after = await $.ui.mount({ ...above(200), surface: "terminal" });
	expect(textOf(await after.drawn())).toBe("engine");
	await after.unmount();
	await footer.unmount();
});

test("the band keeps the engine's mode labels first", async ($, on) => {
	engine(on);

	for (const surface of SURFACES) {
		const ui = await $.ui.mount({
			...band(200, ["focus", "memory paused"]),
			surface,
		});
		const text = textOf(await ui.drawn());
		expect(text.startsWith(`focus & memory paused  ${ICON.directory} `)).toBe(
			true,
		);
		await ui.unmount();
	}
});

test("a nearly full context is marked in words and by inversion", async ($, on) => {
	engine(on, {
		usage: { context: { tokens: 170_000, window: 200_000, percent: 85 } },
	});

	for (const surface of SURFACES) {
		const ui = await $.ui.mount({ ...band(200), surface });
		const warn = await ui.find({
			type: "Text",
			text: /^85% compact soon$/,
		});
		expect(warn?.props.inverse).toBe(true);
		await ui.unmount();
	}
});

test("a running turn shows its own time and adds to the work total", async ($, on) => {
	const clock = engine(on);
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await $.turn.start({ text: "hi", turnId: "t1" });
	await clock.advance(42_000);

	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	expect(textOf(await ui.drawn())).toContain(
		`${ICON.work} 0:42 ${ICON.turn} 0:42`,
	);
	await ui.unmount();

	await $.turn.complete({
		answer: "done",
		durationMs: 42_000,
		isAborted: false,
		turnId: "t1",
		reason: "answer",
	});
	await clock.advance(60_000);
	const after = await $.ui.mount({ ...band(200), surface: "terminal" });
	const text = textOf(await after.drawn());
	expect(text).toContain(`${ICON.work} 0:42`);
	expect(text).not.toContain(ICON.turn);
	await after.unmount();
});

test("a subagent's turn is not the session's work", async ($, on) => {
	const clock = engine(on);
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await $.turn.start({ text: "", turnId: "a1", agentId: "agent-1" });
	await clock.advance(30_000);

	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	const text = textOf(await ui.drawn());
	expect(text).toContain(`${ICON.work} 0:00`);
	expect(text).not.toContain(ICON.turn);
	await ui.unmount();
});

test("outside a repository the band leaves the branch out", async ($, on) => {
	const clock = engine(on, { git: { exitCode: 128, stdout: "" } });
	await $.session.start({
		cwd: "/Users/me/projects/demo",
		surface: "terminal",
		isInteractive: true,
	});
	await clock.settle();

	const ui = await $.ui.mount({ ...band(200), surface: "terminal" });
	const text = textOf(await ui.drawn());
	expect(
		text.startsWith(`${ICON.directory} ~/projects/demo  ${ICON.model} Opus`),
	).toBe(true);
	expect(text).not.toContain(ICON.branch);
	await ui.unmount();
});
