# Checks of the session-band mod.

default: check

# Run every check.
check config=".": lint (typecheck config) test

# Run the checks that need no types from an engine load, as CI does.
# The engine writes `.claude-plugin/types/` only when it loads the mod, and that folder is never committed.
check-without-types: lint test

# Lint the sources and workflows, then validate the plugin as the engine and the plugin directory read it.
lint:
    biome check
    actionlint
    zizmor --no-online-audits .github/workflows
    claude plugin validate --profile directory .

# Type-check with the pinned TypeScript.
# `config` names a tsconfig; the engine writes one here when it loads the mod.
typecheck config=".":
    tsc -p {{ config }}

# Run the plugin's tests against the engine.
test:
    claude plugin test .
