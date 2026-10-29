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

declare module "claude-code" {
	interface PluginState {
		"session-band": {
			tick: number;
			git: Shaped<GitInfo | null>;
			work: Shaped<WorkClock | null>;
		};
	}
}
