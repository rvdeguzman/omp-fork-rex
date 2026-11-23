# omp-rex

Fork an OMP conversation into a Rex pane or tab. Installed as a user-wide OMP plugin; start a new OMP process after installation.

```text
/fork pane       Split right of the OMP terminal
/fork tab        Open a new Rex tab
/fork window     Same as /fork tab
/rex-fork        Same as /fork pane
/rex-fork tab    Explicit plugin command
```

Bare `/fork` remains OMP's native in-place fork. Outside Rex, `/fork` placement commands remain native too. The plugin rewrites only explicit placement requests received by the main interactive session's input hook; it does not override OMP's built-in command registry.

## Installation

Requires OMP 19.1.1 or a compatible extension API, plus the Rex CLI on `PATH`. Run OMP inside Rex so `REX_SESSION` and `REX_BLOCK` identify its session and terminal.

```sh
omp plugin link --scope user /Users/rv/repos/omp-rex
```

For another checkout, pass that checkout's absolute path. No dependencies or build step are required. Restart OMP to load a newly installed plugin.

## Behavior and safety

- The parent stays in its current session and retains focus. Pane forks target the terminal running OMP, not whichever pane the app currently focuses. Rex calls a tab a window.
- The session is materialized and flushed before launch. OMP's `--fork` creates the child's identity and copies its saved conversation and artifacts.
- The child uses the parent's OMP executable, working directory, session directory, active model, resolved thinking level, and prompt-cache identity. Startup configuration flags, extension registrations, config overlays, and non-secret profile/storage scope are forwarded; original prompts, attachments, and one-shot session selectors are not replayed.
- Rex launches argv directly with `--shell=none`; no command text is typed into a shell. Paths and argument values containing whitespace or shell syntax stay individual arguments.
- Forking while busy requires confirmation; an unfinished response may be absent from the child. Ephemeral sessions and vibe mode cannot fork into another terminal.
- A startup `--api-key` is refused rather than exposed in Rex's process arguments. Use OMP's credential store or credentials already available in Rex's login environment. Parent-only credential environment variables are not copied.
- Unknown startup flags fail closed. The launch-flag table currently targets OMP 19.1; registered extension flags use their runtime types.
- OMP 19.1 exposes its live session manager to extensions, but its readonly TypeScript interface omits `flush()`. This plugin checks that capability at runtime and refuses to fork if unavailable, rather than launching from an unflushed transcript.
- A launch timeout is ambiguous: inspect Rex before retrying. The plugin never automatically retries terminal creation.

## Verification

```sh
bun test
```

Six tests cover prompt/selector removal, credential flags, literal argument preservation, registered extension flag types, end-of-options handling, and unsupported flags. Also verified in actual Rex terminals with OMP 19.1.1: pane, tab, and window placements; separate child identities; copied conversation markers; matching model/thinking/cwd/cache identity; and unchanged native bare `/fork` behavior. No model requests were needed for that smoke scenario.
