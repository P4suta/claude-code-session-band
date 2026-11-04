import type { EngineInterface, Register, RenderInput } from "claude-code";
import { atom, read, update } from "claude-code";

import type { FableUsage, GitInfo } from "../types";
import {
	bandSegments,
	cells,
	endTurn,
	footerRoom,
	GAP,
	ICON,
	layoutBand,
	type Part,
	parseGitStatus,
	shortenPath,
	startTurn,
	tickBucket,
	tildePath,
	workAt,
} from "./format";
import { fablePercent, parseFableUsage, USAGE_REFRESH_MS } from "./usage";

// Bumped to redraw the band; its value means nothing.
const tick = atom({ plugin: "session-band", key: "tick" } as const, 0);
// Change a tag when its value's fields change.
// The new tag declines what an earlier version stored before a reload.
const git = atom({ plugin: "session-band", key: "git" } as const, null, {
	shape: "git-1",
});
const work = atom({ plugin: "session-band", key: "work" } as const, null, {
	shape: "work-1",
});
const fable = atom({ plugin: "session-band", key: "fable" } as const, null, {
	shape: "fable-1",
});

const readFableUsage = async (
	$: EngineInterface,
): Promise<FableUsage | null> => {
	try {
		const authorization = await $.session.authorize();
		if (authorization?.kind !== "bearer") return null;
		const response = await $.http.fetch(
			"https://api.anthropic.com/api/oauth/usage",
			{
				auth: authorization.handle,
				headers: { "anthropic-beta": "oauth-2025-04-20" },
			},
		);

		return response.ok
			? parseFableUsage(response.text, await $.clock.now())
			: null;
	} catch {
		return null;
	}
};

const GIT_STATUS = [
	"git",
	"status",
	"--porcelain=v2",
	"--branch",
	"--untracked-files=no",
] as const;

const readGit = async ($: EngineInterface): Promise<GitInfo | null> => {
	try {
		const run = await $.process.run(GIT_STATUS, { timeoutMs: 5000 });

		return run.exitCode === 0 ? parseGitStatus(run.stdout) : null;
	} catch {
		return null;
	}
};

// Off the dispatch that asked, so a slow repository never holds a turn.
const refreshGit = ($: EngineInterface): void => {
	$.clock.after(0, () => {
		void readGit($).then((info) => update($, git, () => info));
	});
};

const redraw = ($: EngineInterface) => update($, tick, (n) => n + 1);

const style = (part: Part) => ({
	...(part.isBold ? { weight: "bold" as const } : {}),
	...(part.isInverse ? { inverse: true } : {}),
});

export const register: Register = (on) => {
	let usageGeneration = 0;
	let isReadingUsage = false;
	let isPollingUsage = false;
	on("session.start", async ($, e, next) => {
		usageGeneration += 1;
		await update($, fable, () => null);
		const refreshUsage = (): void => {
			if (isReadingUsage) return;
			const generation = usageGeneration;
			isReadingUsage = true;
			void readFableUsage($)
				.then(async (usage) => {
					if (generation === usageGeneration)
						await update($, fable, () => usage);
				})
				.catch(() => undefined)
				.finally(() => {
					isReadingUsage = false;
				});
		};
		$.clock.after(0, refreshUsage);
		if (!isPollingUsage) {
			isPollingUsage = true;
			$.clock.every(USAGE_REFRESH_MS, refreshUsage);
		}
		let last: number | undefined;
		$.clock.every(1000, () => {
			void Promise.all([$.clock.now(), $.session.usage(), read($, work)])
				.then(async ([now, usage, clock]) => {
					const isWorking = workAt(clock, usage.startedAt, now).turnMs !== null;
					const bucket = tickBucket(isWorking, usage.startedAt, now);
					if (bucket === last) return;
					last = bucket;
					await redraw($);
				})
				.catch(() => undefined);
		});
		refreshGit($);

		return next(e);
	});

	on("session.end", async ($, e, next) => {
		if (e.reason === "logout") {
			usageGeneration += 1;
			await update($, fable, () => null);
		}

		return next(e);
	});

	on("turn.start", async ($, e, next) => {
		if (e.agentId === undefined) {
			const [now, usage] = await Promise.all([
				$.clock.now(),
				$.session.usage(),
			]);
			await update($, work, (clock) => startTurn(clock, usage.startedAt, now));
		}

		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (e.agentId === undefined) {
			const usage = await $.session.usage();
			await update($, work, (clock) =>
				endTurn(clock, usage.startedAt, e.durationMs),
			);
			refreshGit($);
		}

		return next(e);
	});

	on("classic.CwdChanged", ($, e, next) => {
		refreshGit($);

		return next(e);
	});

	on("classic.PostModelSwitch", async ($, e, next) => {
		await redraw($);

		return next(e);
	});

	on("session.measure", async ($, e, next) => {
		await redraw($);

		return next(e);
	});

	// The hint line shares the footer row; its width bounds the band's.
	let hintCells = 0;
	// Whether the footer site has drawn the band; until then the band sits above the prompt.
	let isInFooter = false;

	on("ui.render", { component: "PromptHint" }, ($, e, next) => {
		const measured = cells(e.props.hint);
		if (measured !== hintCells) {
			hintCells = measured;
			$.clock.after(0, () => {
				void redraw($);
			});
		}

		return next(e);
	});

	// Drawn in place of the mode labels at the right of the footer under the prompt.
	on("ui.render", { component: "SessionMode" }, async ($, e) => {
		if (!isInFooter) {
			isInFooter = true;
			$.clock.after(0, () => {
				void redraw($);
			});
		}
		const modes = e.props.modes.join(" & ");

		return drawBand(
			$,
			e,
			footerRoom(e.viewport?.columns ?? 80, hintCells),
			modes === "" ? "" : `${modes}${GAP}`,
		);
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		await read($, tick);
		if (isInFooter || e.props.hasSurvey) return next(e);

		return drawBand($, e, e.props.bodyColumns, "");
	});
};

const drawBand = async (
	$: EngineInterface,
	e: RenderInput<"SessionMode" | "AbovePrompt">,
	room: number,
	lead: string,
) => {
	await read($, tick);
	const [now, usage, model, cwd, home, gitInfo, clock, fableUsage] =
		await Promise.all([
			$.clock.now(),
			$.session.usage(),
			$.session.model(),
			$.session.cwd(),
			$.env.get("HOME"),
			read($, git),
			read($, work),
			read($, fable),
		]);

	const path = tildePath(cwd, home);
	const segments = bandSegments({
		git: gitInfo,
		model,
		sessionMs: now - usage.startedAt,
		contextPercent: usage.context.percent,
		work: workAt(clock, usage.startedAt, now),
		usd: usage.cost?.usd,
		weeklyPercent: usage.rateLimits.find((limit) => limit.kind === "seven_day")
			?.percentUsed,
		fablePercent: fablePercent(fableUsage, now),
	});
	const prefix = `${ICON.directory} `;
	const layout = layoutBand(
		cells(path),
		segments,
		Math.max(0, room - cells(lead) - cells(prefix)),
	);
	const { Box, Text } = $.ui.resolve(e);

	return (
		<Box>
			<Text wrap="truncate-end">
				{lead}
				{prefix}
				<Text weight="bold">{shortenPath(path, layout.pathCells)}</Text>
				{layout.shown.flatMap((segment) => [
					segment.gap,
					...segment.parts.map((part) => (
						<Text {...style(part)}>{part.text}</Text>
					)),
				])}
			</Text>
		</Box>
	);
};
