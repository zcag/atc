# Settings and doctor

## Check what is set up

`atc doctor [-json]` lists what each feature needs and how it stands, with the fix beside anything
not working and what it costs (a GPU, a paid key, plan tokens). Settings shows the same list, and the
page opens on it when Claude Code is missing or signed out. The list is one registry in the code
(`internal/caps`), and each check really probes: it runs `claude --version` and
`claude agents --json`, and calls each service with a short timeout. Optional and never set up is
quiet; something set up that stopped working warns. Doctor exits 1 only when something required is
missing or something set up is broken. `atc version` prints the build.

A row in Settings can also start a session to set that feature up, with what the row knows as its
first message.

## Where settings live

Settings can be kept in `settings.json` in the config folder (`~/.config/atc/`, or `ATC_CONFIG_DIR`),
which Settings' Save writes, with the file mode private because it can hold keys. The API never
returns a secret in clear. A variable in the environment always wins over it, so an existing `env`
file keeps working as it is:

```json
{"user": "Ada", "assistant": "Sam", "language": "en", "env": {"ATC_BROWSER": "http://127.0.0.1:9222"}}
```

`user` and `assistant` fill `{{user}}` and `{{assistant}}` in the built-in prompts (`{{User}}` and
`{{Assistant}}` at a sentence's start), "the user" and "the assistant" without them; your own files
in `~/.config/atc/modes` are never touched. `language` is the default for `ATC_STT_LANGUAGE`. atc
reads all of it when it starts, and says when something waits for a restart.

`atc prompts` prints every text the assistant is told, with your own files applied. With
`--update` it records them, and `--check` then shows what a newer atc changed.

## Settings by feature

Core:

| Variable | What it does |
|---|---|
| `ATC_ADDR` | Where to listen, default `127.0.0.1:7272` |
| `ATC_ROOTS` | Folders whose subfolders are offered for new sessions, separated by `:` |
| `ATC_CLAUDE_BIN` | Where `claude` is, when it is not on the service's PATH |
| `ATC_CLAUDE_ARGS` | Extra flags for sessions atc starts |
| `ATC_CONFIG_DIR` | The config folder |
| `ATC_PUBLIC_URL` | The HTTPS address atc answers at, for links and pairing |
| `ATC_TOKEN`, `ATC_URL` | The login and server the `atc` client uses, instead of a saved login |
| `ATC_TRUST_TAILNET`, `ATC_TRUSTED_PROXIES` | See [Security](security.md) |
| `ATC_CONTAIN` | `1` starts sessions in `claude.slice` on systemd |

Features, each on its own page:

- Assistant and hub: `ATC_HUB`, `ATC_HUB_ADDR`, `ATC_HUB_CLAUDE_ARGS`, `ATC_ASSIST_DIR`:
  [The assistant](assistant.md)
- Calls: `ATC_CALL_LINE`, `ATC_CALL_NUMBER`, `ATC_CALL_LINE_NUMBER`, `ATC_CALL_VOICES`,
  `ATC_CALL_TEST_LINE`, `ATC_CALL_TEST_FROM`: [Calls](calls.md). `ATC_DELTA_CALL`, the older name for
  `ATC_CALL_LINE`, still works.
- Android app: `ATC_APP_DIR`: [Android app](android.md)
- Agents: `ATC_AGENTS`: [Presets and agents](presets-and-agents.md)
- Shared browser: `ATC_BROWSER`: [A browser for sessions](browser.md)
- opencode: `ATC_OPENCODE`, `ATC_OPENCODE_BIN`: [Other models and opencode](models.md)
- Summaries: `ATC_SUMMARY`, `ATC_SUMMARY_URL`, `ATC_SUMMARY_MODEL`: [Summaries](summaries.md)
- WhatsApp and speech: `ATC_WHATSAPP_*`, `ATC_STT_*`, `ATC_TTS_*`, `ATC_SPEECH_LLM_*`:
  [WhatsApp and speech services](whatsapp.md)
