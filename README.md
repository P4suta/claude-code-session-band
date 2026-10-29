# `session-band`

A Claude Code mod that keeps the directory, git branch, model, work time, context, cost, and rate limit on the line under the prompt.

## Installation

```sh
/plugin install session-band --marketplace P4suta/claude-code-session-band
```

## Usage

```sh
# Type the install line at the prompt of a Claude Code terminal session, answer `y` to add the marketplace, and choose a scope.
# From a shell, `claude plugin install session-band --marketplace P4suta/claude-code-session-band` does the same.
# The band then sits on the mode line under the prompt, and above the prompt until the engine first draws that line.
# A narrow terminal drops the rate limit first, then the cost, the git branch, the work time, the context, the session time, and the model.
# A context at 80% or more reads `compact soon` in inverse text.
# The icons come from Nerd Fonts, so the terminal needs a Nerd Font to draw them.
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE-APACHE) or the [Massachusetts Institute of Technology (MIT) license](LICENSE-MIT), at your option.

Contributions use both licenses unless you state other terms.
