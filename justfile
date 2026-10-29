# Checks of the session-band mod.

default: check

# Run every check.
check config=".": lint (typecheck config) test

# Run the checks that need no types from an engine load, as CI does.
# The engine writes `.claude-plugin/types/` only when it loads the mod, and that folder is never committed.
check-without-types: lint test

# Each recipe runs its tools through `mise x`, so a shell without mise activation still gets the pinned versions.

# Lint the sources and workflows, then validate the plugin as the engine and the plugin directory read it.
lint:
    mise x -- biome check
    mise x -- actionlint
    mise x -- zizmor --no-online-audits .github/workflows
    mise x -- claude plugin validate --profile directory .

# Type-check with the pinned TypeScript.
# `config` names a tsconfig; the engine writes one here when it loads the mod.
typecheck config=".":
    mise x -- tsc -p {{ config }}

# Run the plugin's tests against the engine.
test:
    mise x -- claude plugin test .
