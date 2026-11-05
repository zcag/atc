# Calls

Calls are an add-on: `atc voice install [--lang en] [--also tr] [--engine pocket-en]` sets up the call stack (`voice/`, its README lists the settings) on this machine: Linux with systemd for now, CPU only by default, about 2 GB on disk. `atc voice status` and `atc voice uninstall [--purge]` do what they say. No phone is needed: the atc app and the browser call it over atc.

On CPU a call works on 2 cores (first audio about 2.5 to 3.2 s after you stop, most of it Claude's first token; the voice breaks up on 1 core). Streaming speech recognition is the weakest part: it reads some words wrong, which the assistant then has to guess at.

atc has no voice mode in a session: to talk, call the assistant. **Call about this** in a session's
menu or the palette tells it which session you mean. On the call, the assistant can hand the line to [an agent that
can talk](#talking-to-an-agent).

Calls are an add-on. They need three services next to [the hub](assistant.md), each with a row in
Settings: the **call line**, which carries a call's audio; a **talker**, which holds the call (hears
you, knows when you are done, speaks the assistant's words); and a **voice service**, which lists the
voices and keeps your pick. They cost a GPU, or a CPU with slower replies, plus plan tokens.

```sh
ATC_CALL_LINE=http://127.0.0.1:8807      # the call line, for atc call and the app
ATC_CALL_VOICES=http://127.0.0.1:8806    # the voice service
ATC_CALL_NUMBER=+15550100                # optional: the number atc call rings, defaults to the first ATC_WHATSAPP_OWNER
ATC_CALL_LINE_NUMBER=+15550101           # optional: the assistant's own number, shown in the phone's call log
```

## Calling the user

```sh
atc call [--reason TEXT] [--wait] [--timeout 45s] [--app | --phone | --whatsapp]
```

rings the user with the assistant on the line, on the atc app first and on the SIM phone line when
the app does not ring within 8 s (no data, phone off, an old app). It only ever calls the user's own
number. When they pick up, the assistant is on the line: its first message carries the reason and,
from another session, that session's sender line, so it says why it called and passes their answer
back with `send`. The talker sends that first message while it still rings, so the hub marks it as
ringing and the opening is ready the moment they answer. Without `--wait` the command returns at once,
and a call nobody picks up comes back to the session that asked as a message saying so (the
assistant's own calls come back on the channel it was busy with). `--wait` prints the outcome instead:
`answered`, `no-answer` or `busy` (a call is already on). A call they decline in the app is not
retried on the phone line. `--app` and `--phone` pin one line; `--whatsapp` makes it a WhatsApp voice
call from the bot account instead.

## Talking to an agent

The assistant answers every call. An agent with `"talk": true` in its `agent.json` can take the line from it, in
that same call, and hand it back.

- **Moving the line.** Say so ("put Focus on"): the assistant connects you when it finishes speaking. In the app or
  the page, tap the name on the call screen (or the strip of names, or ⋯ Talk to). An agent's **Call** button
  (Agent details) starts a call that opens on it. "Back to the assistant" works on any line, also while the agent is
  in the middle of a long tool, because the talker hears it, not the agent. On a phone line with no screen, the
  words are all there is.
- **Knowing who you hear.** Two notes on every move (rising to an agent, falling back), then the one you moved to
  speaks first, knowing what was just said. With `"person": "<id>"` in its `agent.json` it has that person's voices
  and avatar. The app shows its name.
- **Busy or asleep.** An agent in the middle of a turn, or waiting on a permission prompt, can't take the line: it
  stays where it is, and the one you are talking to says so and offers to pass a message. One that is stopped or
  has no conversation yet starts in about 2 seconds.
- **What you miss.** While you talk to an agent, reports still reach the assistant, who is told you are elsewhere,
  and the next time you are back it tells you what you need to hear. `atc call` from anything rings on the line
  instead (outcome `knocked`): two notes and one sentence in the assistant's voice at the next pause.
- **What it costs the agent.** Nothing lasting. While on the line its conversation runs in the hub as a stream-json
  process on its own session, so its words stream to the voice; messages to it (`atc send`, wake-ups) go through the
  hub, and its reply to those isn't spoken. The way it talks comes from one talk-mode message at the start of the
  line (`modes/line.md`), and the end-of-call message returns it to writing; those and the short spoken turns are
  all that stay in its transcript. When the call ends and its last turn is done, it goes back to the background.

Moving away from an agent doesn't cut its work: its turn runs on, and it stays open until the call ends, so coming
back is instant. Agents run on the machine with the call line, for now.

## Calls in the app

**Call about this**, in a session's More menu and the palette, starts a call (or returns to the live
one) and tells the assistant which session you mean: `POST /api/call/about` keeps a one-time note that
the feed puts in front of the assistant's next turn, dropped after five minutes if no turn comes. It
hears you through `modes/phone.md` and passes your words on with `send`; it cannot answer a session's
permission prompt, so those are still a tap.

The app makes and takes calls like WhatsApp does: a self-managed Telecom call (Android 14's own
transactional API, `Telecom.kt`; Android 14 or newer), so the phone's call log and recents list them
(`EXTRA_LOG_SELF_MANAGED_CALLS`) under the assistant's own line, `ATC_CALL_LINE_NUMBER` in atc's env
(so calling back from recents reaches the assistant over the SIM), with an "Assistant" contact the app
adds once if no contact has that number; a missed call gets the app's own notification, so Android
shows its own call notification and lock-screen ring, Bluetooth and car buttons answer and hang up, a
SIM call can put it on hold, and audio routes between earpiece, speaker and headsets. You call from
the menu (Call the assistant), the Assistant screen or the launcher icon's Call assistant shortcut.

```
phone app ── wss://<atc>/api/call/line (atc's login) ── atc ── ws://127.0.0.1:8807/app ── call line
                                                                                  │ same events as the SIM line
                                                                              talker ── hub
```

- **Audio** is mono s16le in 20 ms binary websocket frames: your voice at 16 kHz (what the speech
  recognition takes), the assistant's at 24 kHz, the voice model's own rate (the SIM line gets 16 kHz).
  The app asks for it with `out_rate`, so an older app still gets 16 kHz. The talker treats an app call
  like any other (`via: app`). The phone records with `VOICE_COMMUNICATION` (Android's echo cancelling)
  and plays after a jitter buffer. Its counters (played, underruns, dropped, buffer depth, the audio
  route and whether echo cancelling is on) reach the call line every 10 s and land in the call's line in
  its log: read them before reaching for Opus or UDP. On speaker or in a car the assistant's voice can
  come back through your mic; the talker drops a turn mostly made of its own words from the last seconds
  (app calls only).
- **The call screen follows the call.** The talker sends `persona` events over the line (listening,
  hearing with your words as they are recognised, thinking, the tool it uses, speaking with the
  sentence) and the screen shows them as a live transcript and a persona. Tapping the persona while
  it speaks or thinks stops it (`interrupt`). A persona (`Persona.kt`) gets those states and reads
  both voices' loudness on the phone every frame it draws, so it moves with the sound and not with
  the network; the first one is an orb drawn by a shader.
- **Persons** bundle what a call shows and speaks with: a name, a character, a background and a voice per
  language, kept on the server in `persons.json` (`GET /api/call/persons`) with which one the assistant is in each
  language. Pick and edit them under Person on the call or Settings, Persons. The talker sends the call's
  language with every `persona` event, so when the language changes the call screen swaps character, background and
  name at once while the voice changes with it. A pick tells the voice service, so the phone line speaks with it too.
  With nobody picked for a language, the character kept on that device shows, and the voice service's voice speaks. A
  person holds nothing about how the assistant behaves, and nothing in it is tied to the assistant, so an agent can name one too.
- **Backgrounds** are images in `$ATC_APP_DIR/personas/_rooms/`, best at a character's 768x1344. One replaces a `rig`
  character's room, darkened and softened like its own, without the lamp's glow and dust; it goes behind a `minimal` one
  under a dark wash. The orb and the other kinds draw their own surroundings.
- **Characters** are folders under `$ATC_APP_DIR/personas/<name>/` on the server (`persona.json` with
  `kind` and `files`, plus the files), listed in `personas/index.json` (`{"default", "personas":
  [{"name", "rev"}]}`); the phone downloads one when picked and keeps it until its `rev` changes.
  atc ships none besides the orb. The kept one starts from the phone with no wait on the server, on the
  dark backdrop until its first frame; the orb shows only when it is the choice, or when the character
  is missing or stuck for 6 s. A long press on the persona switches to the language's next person, or with no persons to
  the next character. Kinds: `minimal` (a
  shader line or bars, `web/minimal.js`), `rig` (drawings swapped like cel animation, `web/rig.js`,
  built as in [the rig's notes](persona-rig.md)), `illustration` and `footage` (`web/persona.js`, in the
  app through a WebView), and `head3d` (`Head3D.kt`, a glTF head with ARKit morph targets drawn by
  Filament and driven by `Animator.kt`: `nodes` names its head and eye bones, `axes` which local axis of
  each turns which way, `rest` a starting pose (arms down from a T-pose), `camera` and `focal` the
  framing). Ship a `head3d` model uncompressed: Filament can't normalize the skinning weights that
  quantizing (and so meshopt) writes, and the body disappears.
- **Android Auto** sees atc as a calling app (`CarCalls.kt`, category `CALLING`, Car App library):
  a Call button on the car screen, and Android Auto's own in-call view for every app call. A
  sideloaded app only shows up after Android Auto's developer settings allow unknown sources.
  Plain Bluetooth in the car works through Telecom without it.
- **You calling:** the app sends `call`; the talker answers at once and greets.
- **A call to you:** the hub dials `via: app`, which the call line keeps quiet, and emits a `ring`
  event; atc pushes `{"ring": {"reason", "at"}}` through UnifiedPush. The app takes rings younger than
  60 s, opens the line and sends `ringing`; only then does the call line announce the call, so the
  talker starts the opening. Answering sends `accept`.
- **One device per call.** A call belongs to the connection that placed or took it; another device
  is told busy (call) or gone (ringing, resume) and can't take it over.
- **Testing:** calls from the addresses in `ATC_CALL_TEST_FROM` (a machine running an emulator, say)
  go to `ATC_CALL_TEST_LINE`, a separate call line with a fake talker on it, so a test never touches
  the live line.
- **In a browser** (no app), the same menu item and Assistant choice open `#/call`, a web call on the
  same line (`web/call.js`, its audio worklets in `web/call-worklet.js`): the microphone with the
  browser's echo cancelling, resampled to 16 kHz frames, and the assistant's 24 kHz frames through
  the same jitter buffer as the app, the orb ported to WebGL, and the same `stats` with `"client":
  "web"`. Playback goes through a MediaStream into an `<audio>` element, which every engine's echo
  canceller hears (Chromium 155 on Linux cancels plain Web Audio as well, measured on a loopback
  sink). It can only place calls, not take a ring, and it lasts as long as the tab: closing it hangs
  up. `/api/me` says `call: true` when atc has a call line.
- **A dropped line** (the phone changed networks) reconnects with `resume` within 8 s; after
  that the call ends.
- `internal/server/callline.go` is atc's side, `android/.../Call.kt` the call itself and
  `CallScreen.kt` its screen, notification and service.
