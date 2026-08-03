# cma-agent

Runs Configure My AI work on your own machine, using the Claude Code you already
installed and signed into — so a configuration can spend your Claude Pro or Max
plan instead of an API key.

## The one thing to understand

**Your Claude credential never leaves this machine.** The companion doesn't read
it, store it, or transmit it. Claude Code reads its own login from your OS
keychain when we spawn it, exactly as it does when you run `claude` yourself.

What Configure My AI stores is a routing target: this machine's name, the labels
you gave your Claude logins, and which one a given provider should use. There is
no secret on the server side to leak.

## Install

```sh
brew install 9thdesigns/tap/cma-agent
```

Or, without Homebrew — npm installs the git URL directly, so this is still one
line:

```sh
npm install -g https://github.com/9thdesigns/cma-agent
```

Homebrew pulls Node in as a dependency; npm assumes you already have Node 20+.
Either way you also need [Claude Code](https://claude.com/product/claude-code)
installed and signed in.

To uninstall: `brew uninstall cma-agent`, or
`npm uninstall -g @configuremyai/cma-agent`.

### Publishing

`bin/release-agent` in the main repository does the whole release: it mirrors
this directory into a public source repository, tags the version from
`package.json`, checksums the tarball GitHub generates for that tag, and commits
the filled-in formula to the tap.

It needs two repositories, both **public**, both empty to start with:

| Repository | Holds |
| --- | --- |
| `github.com/9thdesigns/cma-agent` | this directory, mirrored on each release |
| `github.com/9thdesigns/homebrew-tap` | `Formula/cma-agent.rb` |

The tap **must** be called `homebrew-tap`. That name is what lets Homebrew
resolve the short form `9thdesigns/tap`. (An earlier version of these docs said
`configuremyai/tap` — no such org, which is why `brew install` failed.)

```sh
bin/release-agent --dry-run   # render everything, push nothing
bin/release-agent             # publish
```

Then set these on the web app so the walkthrough and docs stop telling people to
build from source:

```sh
CMA_AGENT_INSTALL_COMMAND="brew install 9thdesigns/tap/cma-agent"
CMA_AGENT_UNINSTALL_COMMAND="brew uninstall cma-agent"
```

`agent/` here stays the source of truth — the public repository is a publish
target, overwritten on every release, so the two cannot drift.

The formula lives at `agent/homebrew/cma-agent.rb` with placeholders the script
fills. Edit that one, never the copy in the tap.

## Setup

```sh
cma-agent pair      # enter the code from /devices/setup
cma-agent start     # wait for work
```

`cma-agent status` shows pairing state, Claude Code version, and every Claude
login it can see.

## More than one Claude account

Each login lives in its own `CLAUDE_CONFIG_DIR`, so a work account and a personal
account never mix:

```sh
cma-agent claude:add --label "Work" --account you@work.com
cma-agent claude:add --label "Personal"
```

`--account` is optional and only used to show a masked hint (`y•••@work.com`) so
you can tell two logins apart in a dropdown. It is not read from Claude Code's
files, and it is not used for authentication.

Both labels then appear in the **Claude login** picker when you create an
Anthropic provider in the web app.

> **macOS note.** Claude Code stores credentials in the system Keychain, and how
> completely a per-profile `CLAUDE_CONFIG_DIR` isolates them can vary by Claude
> Code version. Run `cma-agent claude:scan` after adding a second login and check
> the reported state — if two profiles have collapsed onto the same account, you
> will see it there rather than discovering it when the wrong plan gets billed.

## How a run works

1. The web app queues a prompt for this machine.
2. `cma-agent start` is long-polling, and claims it.
3. It runs `claude -p … --output-format json` under the chosen profile.
4. The answer and token counts go back; the queued copy is deleted.

Connections are outbound only. Nothing listens, no ports open, no firewall rules.

## Commands

| Command | What it does |
| --- | --- |
| `pair` | Link this machine to your account |
| `start` | Claim and run work (leave running) |
| `verify` | Restore a session that lapsed after two weeks of silence |
| `status` | Pairing, session and Claude login state |
| `claude:add --label X` | Add a separate Claude login and sign into it |
| `claude:login --profile X` | Sign a login in again after it expires |
| `claude:list` | Show logins on this machine |
| `claude:scan` | Re-check every login and report to the web app |
| `claude:remove --profile X` | Delete a login and its credential from this machine |

## Environment

| Variable | Purpose |
| --- | --- |
| `CMA_SERVER_URL` | Point at a different host (default `https://configuremyai.com`) |
| `CMA_DEVICE_TOKEN` | Supply the device token directly instead of `config.json` |
| `CMA_AGENT_HOME` | Where state lives (default `~/.configure-my-ai`) |
| `CMA_CLAUDE_BIN` | Path to the `claude` binary. Only needed for a non-standard install — `~/.local/bin`, Homebrew and the npm/bun globals are found automatically, on `PATH` or not |
| `CMA_RUN_TIMEOUT_MS` | Per-run ceiling (default 150000) |

## Keeping it awake

A sleeping Mac can't answer. Either stop it sleeping while on power (System
Settings → Battery), or run it under `caffeinate`:

```sh
caffeinate -s cma-agent start
```

## Depending on another product's CLI

Every Claude Code flag this companion relies on is gathered in the `CLI` object
at the top of `src/claude.js`. They are verified against **Claude Code 2.1.220**.
If a Claude Code upgrade breaks a run, that object is the only place that should
need editing.

Two behaviours worth knowing about that build, both handled in `src/claude.js`:

- The result envelope has no top-level `model`; the model that ran is the key of
  `modelUsage`.
- In-band failures (API errors, rate limits) come back with **exit code 0** and
  `is_error: true`. Trusting the exit code alone would render the error text as
  the assistant's reply.

## Limits

- Headless Claude Code takes a single prompt, so prior turns are flattened into
  it. Long conversations cost more here than the same conversation would on the
  Messages API with prompt caching.
- Work only runs while this machine is awake and online. Chat, code sessions and
  the composer are fine; embedded widgets, API endpoints and scheduled bots need
  a credential that works without you.
