export type GitInfo = {
	branch: string;
	changes: number;
	ahead: number;
	behind: number;
};

export type WorkClock = {
	sessionStartedAt: number;
	totalMs: number;
	runningSince: number | null;
};

export type FableUsage = {
	percentUsed: number;
	resetsAt: number | null;
	fetchedAt: number;
};

declare module "claude-code" {
	interface PluginState {
		"session-band": {
			tick: number;
			git: Shaped<GitInfo | null>;
			work: Shaped<WorkClock | null>;
			fable: Shaped<FableUsage | null>;
		};
	}
}
