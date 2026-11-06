# Other models and opencode

## Other models

Claude Code runs on any model served through Anthropic's Messages API (`/v1/messages`): Ollama
serves it natively, and LiteLLM or claude-code-router put it in front of an OpenAI-only server.
List them in `engines.json` in the config folder, on the machine whose sessions use them:

```json
[{ "name": "qwen", "model": "qwen3:30b-a3b-instruct-2507-q4_K_M", "url": "http://gpubox:11439" }]
```

New session then shows a Model line (Claude stays the default), and those sessions carry the
engine's name on their strip. atc remembers each session's engine and resumes it there; a session
started elsewhere is resumed on the engine whose `model` matches the model in its transcript. Each
engine sets `ANTHROPIC_BASE_URL`, an auth token (`token`, default `local`) and every model alias to
`model`, through `--settings`; `env` adds or overrides variables, and `args` adds Claude flags (for a
local server, `--exclude-dynamic-system-prompt-sections` moves the folder-specific text out of the start
of the prompt, so a new folder reuses most of the cache). It also turns off Claude Code's
attribution header (`CLAUDE_CODE_ATTRIBUTION_HEADER=0`): it sits at the start of every prompt and
differs per session, so a local server's prompt cache never matched and each new session re-read
~30k tokens. On an MLX Qwen server a new session's first turn went from 62-73 s to 2.7 s with it off.
Replies from models not named `claude-*` cost nothing and are left out of the plan's daily usage.

## opencode

atc also runs [opencode](https://opencode.ai) sessions next to Claude's, through one headless
`opencode serve` on the same machine. That server keeps every session alive the way Claude's
background service does, for every folder at once, so opencode sessions survive atc restarting
too. Run it as its own service, never under atc. With opencode installed:

```sh
atc service install --only opencode    # systemd or launchd, on 127.0.0.1:4096
```

That points atc at it (`ATC_OPENCODE` in `~/.config/atc/env`). Then add an engine with `"harness": "opencode"`:

```json
{ "name": "opencode", "harness": "opencode", "model": "mlx/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ" }
```

`model` is opencode's `provider/model` from its own config; leave it out to use opencode's
default. Without `ATC_OPENCODE` nothing about atc changes.

The service runs with its own config folder, `~/.config/atc/opencode`: `config.json` links to
your normal opencode config so providers stay in one place, `opencode.json` makes `atc` the default
agent, and `agent/atc.md` (from `deploy/opencode/`) is that agent: a short prompt and only the core
tools (question, bash, read, glob, grep, edit, write). The unit also turns off opencode's
Claude Code compatibility (`~/.claude/CLAUDE.md` and `~/.claude/skills`) and external skills. A
local model needs this to be usable: what gets resent on every step has to fit the server's prompt
cache, or every step re-reads it all. Measured with MLX Qwen3-Coder-30B, one step in atc's own repo:

| Setup | Prompt | First step |
|---|---|---|
| opencode defaults (global AGENTS.md, Claude skills, `build` agent) | 25,856 tokens | 72 s |
| own config folder, Claude compatibility off | 6,022 | 11.7 s |
| plus the `atc` agent | 3,607 | 5.4 s |

With the `atc` agent, an 8-step fix-the-failing-test task took 22 s in total: after the first
step each one sent 15-97 new tokens and read the rest from the cache. Your own `opencode` in a
terminal keeps its normal config.

An opencode session is a full atc session: its strip, states and push, the terminal
(`opencode attach`, shared and sized like any other), transcript, summary, outputs, usage (tokens,
no cost), send and the MCP tools. What maps differently:

- **State** comes from the server: busy is working; a pending question or permission is needs
  you, with the question as the activity line.
- **Questions and permissions** show above the session's terminal with their options as buttons
  (Allow once / Always allow / Reject for a permission), answered through the server.
  `opencode attach` does not show a question asked before it attached, which is the usual case
  when you open a session because atc said it needs you.
- **Which sessions are live:** the ones atc started or resumed, and any session that starts
  working on the server, until you stop or remove them. Stop interrupts the turn and keeps the
  session resumable; remove takes it off the list, and the conversation stays in history.
- **Presets** give the folder, name and brief. The brief goes in as hidden context with the first
  message, so it stays in the conversation. `args` are Claude flags and are not used, and git
  worktrees are Claude-only.
- **After a reboot**, a session that was working gets the same "continue" message as Claude's.
- Sessions from a plain `opencode` in a terminal run their own server: they show in history, not
  as live.
