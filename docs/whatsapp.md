# WhatsApp and speech services

This is the advanced end of atc. It needs a gateway and a second phone number, and it comes with no
promises: unofficial WhatsApp gateways can break or get a number banned.

## WhatsApp

atc can put one standing session, named `whatsapp`, behind a WhatsApp account of its own, so you
talk to it from your own number and its replies arrive as ordinary messages with ordinary
notifications. It needs an [OpenWA](https://github.com/rmyndharis/OpenWA) gateway with that second
account linked as a session. Only your number reaches the session: OpenWA's webhook filter lets
nothing else through, and atc checks the signature and the sender again (an `@lid` sender is
resolved to its number through WhatsApp) and ignores anyone else without a word.

```sh
ATC_WHATSAPP_URL=http://openwa:2785              # the gateway
ATC_WHATSAPP_KEY=...                             # its API key
ATC_WHATSAPP_SESSION=<uuid>                      # the linked account, as an OpenWA session id
ATC_WHATSAPP_OWNER=15550100,1234567890@lid       # your number first, then other ids you write from
ATC_WHATSAPP_SECRET=<16+ random characters>      # signs every delivery
ATC_WHATSAPP_HOOK=http://<this host>:7272/api/whatsapp/hook   # atc registers it on start
ATC_PUBLIC_URL=https://atc.example                # optional: where links in messages point
```

atc registers two webhooks at that URL: messages, filtered by sender, and reactions, edits and poll
votes, filtered by chat (a sender filter would drop reactions, which carry no sender).

The conversation is one session, kept and resumed like `assistant` (in `ATC_ASSIST_DIR`), parked so
atc's own pushes don't repeat what WhatsApp already told you. Dropped from Claude's background list,
it is resumed from its transcript. With a hub (see [The assistant](assistant.md)) WhatsApp reaches the
hub's conversation instead. What you send is typed into it: text, a reply to an earlier message with
that message quoted, photos and files saved to disk with their path, voice notes transcribed
(`ATC_STT_URL`), locations as coordinates, an edit with what it said before, a tap on one of its polls
(votes settle for a few seconds, so changing your mind sends one answer), and a reaction to one of its
questions (👍 is yes). A reaction to anything else starts nothing. Messages sent while it works join
the turn it is on. Your message gets ⏳ while it works and ✅ once everything you sent has been answered.

Its replies go out as they are written, Markdown turned into WhatsApp's markup. A table is drawn as
an image by atc's browser (`ATC_BROWSER`; without one it becomes monospace text), long code goes as
a file, and anything over a message's length is split at paragraphs. A long final answer goes out
with its summary first (📌 the status and the gist), so the notification tells you the outcome, and
as a `reply.md` document past a couple of screens. While a turn runs quiet, one status message
shows what it is doing, edited in place, and the typing indicator stays on. A voice note gets a
spoken answer back as a voice note, in the language you spoke whatever the written reply is in:
Claude (haiku, through `claude -p`) turns the reply into a few sentences said out loud in that
language (without Claude, the speech model shortens it in the reply's own). It needs
`ATC_TTS_URL`, a voice for that language such as `ATC_TTS_TR_URL`, and OpenWA's
`MEDIA_CONVERSION_ENABLED`.

The session works as a switchboard: it answers and looks things up itself, and hands anything bigger
to a session of its own, relays that session's report, follows up and stops it when it is done.
Turns nobody started from WhatsApp (such a report, or you typing into the conversation in atc) are
relayed too. A page it shows with `atc show` arrives as a screenshot (HTML), the file itself
(image, PDF), or messages (Markdown), with a link to the live page. It sends what a reply can't
carry with `atc wa`: `--file`, `--render page.html` (drawn as an image), `--voice TEXT`, and
`--poll QUESTION --option A --option B` (`--multi` for several). `/status` lists your sessions,
`/stop` interrupts it, `/new` starts a fresh conversation (the last one stays in atc under a dated
name) and `/help` lists all this.

## Guests

A few other people can write to the same account: a friend asking about a site of theirs, say.
`atc guest add sam 15550101` adds one (`atc guest` lists them, `atc guest rm` removes one); the list
is `~/.config/atc/guests` on the machine WhatsApp runs on, read fresh on every message, so a change
needs no restart. The assistant adds someone only when you ask, and first shows you the introduction
it will send them. atc registers a third webhook for every direct message (a guest may write from an
`@lid` only atc can resolve) and drops anyone who is neither the owner nor a guest.

Guests never reach the assistant: the hub runs a second conversation for them, **guests** (`@guests`,
working in `~/guests`), and a guest's message goes there on the `guest` channel (`[WhatsApp DM · guest
sam]` in front, photos and voice notes as for the owner), where the reply reaches no one. It
answers the guest with `atc wa --to sam` (text, files, a voice note; no polls), which refuses any name
not in the list. One conversation serves every guest, so it keeps each one's context in
`~/guests/<name>/notes.md` (who they are, their open threads, files made for them) and starts work for
them as sessions in `~/guests/<name>`, which report back to it. Quick work it does itself; anything
longer goes to such a session, so its own conversation stays small. Once a day (10:00) atc wakes it to
go through every guest's and group's notes for what is due: a promise, a reminder, something it
watches. A session it starts (or one of those starts) runs only in `~/guests`, only on this machine,
and without your WhatsApp tools or atc's settings, so it can reach people only through the guests'
conversation.

What needs you it brings to the assistant with `report`; the assistant asks you on whatever channel
you are on and passes your yes back with `send @guests` and `approved`. Only the assistant can mark a
message as your go-ahead (atc refuses `approved` from any other session, the guests' conversation
included), so nothing a guest says can approve anything as long as its Claude follows its brief: see
[what atc does not enforce](security.md#what-atc-does-not-enforce). Its Claude loads only atc's MCP
(`--strict-mcp-config`): no WhatsApp, mail or browser of yours. A `mcp.json` in `~/guests` adds the
tools you want it to have (a wiki your groups plan in, say) and a `settings.json` there holds back what
you don't, as in an agent's folder; its edit tools can't change either. In atc it shows under
`@agents`, sessions in `~/guests` group under one **guests** project and stay out of the full list
unless one needs you, and none of it pushes to your phone. It needs the hub.

## Groups

atc's account can sit in WhatsApp groups too: a trip being planned with friends, say. Add it to a group you are in
and it takes part. Being in the group yourself is the whole admission: the other members need not be guests. atc
registers two more webhooks, one for every group message and one for joins and leaves, and drops any group you are
not a member of (it asks WhatsApp who is in each group, and asks again when someone joins or leaves).

Every message in such a group goes to the guests' conversation, on the same `guest` channel as a guest's own
chat, so a guest who is also in a group is one person to it. It decides itself whether a message is meant for it,
for everyone, or for the others among themselves, and answers, chips in or stays quiet. atc writes in front of each message which group it is and who
wrote it, from the verified sender: your own messages are marked as yours, everyone else's as a member with their
WhatsApp name and number (and their guest name when they are one), so nothing a member types can pass for you, and
a line imitating atc's is quoted. It also says when the message mentions the account (a mention reads as the
name, not WhatsApp's bare id), and the guests' conversation hears once when it is added to a group. In atc's transcript these
messages read as messages: who wrote them, in which group, a voice note, the message it replies to, a file; and
what it sent with `atc wa` as what went out, to whom. It answers with `atc wa --group NAME` (text, files, a voice note; no polls), which atc
refuses for any group you are not in. It needs the hub.

It keeps notes per group in `~/guests/groups/<group>/notes.md` and treats your messages in a group as your word
for that group's matters. Longer work for a group goes to a session in `~/guests/groups/<group>`, as for a guest.

`atc group` lists the groups the account is in: `in`, `quiet`, or `without you`. `atc group quiet NAME` keeps atc
out of a group you are in (a group the account posts alerts to, say), `atc group on NAME` lets it back in; the list
is `~/.config/atc/groups-quiet`, read fresh on every message.

## Speech services

These services are for WhatsApp voice notes, in and out. They all speak the OpenAI API (a local
Whisper server works):

```sh
ATC_STT_URL=http://localhost:8000/v1/audio/transcriptions
ATC_STT_MODEL=whisper-1                                         # optional
ATC_STT_PROMPT=...                                              # optional: words to bias it toward
ATC_STT_LANGUAGE=en                                             # optional, else Whisper guesses per clip
ATC_STT_LANGUAGES=en,tr                                         # optional: guess, but only among these
ATC_SPEECH_LLM_URL=http://localhost:8001/v1/chat/completions    # optional: shortens a spoken reply
ATC_SPEECH_LLM_MODEL=qwen
ATC_TTS_URL=http://localhost:8002/v1/audio/speech               # optional
ATC_TTS_MODEL=tts-1
ATC_TTS_VOICE=alloy
ATC_TTS_TR_URL=http://localhost:8003/v1/audio/speech            # optional: a voice for Turkish
ATC_TTS_TR_MODEL=speaches-ai/piper-tr_TR-fahrettin-medium
ATC_TTS_TR_VOICE=fahrettin
```

`ATC_TTS_<LANG>_URL` (with `_MODEL` and `_VOICE`) gives one language its own text-to-speech engine,
for a language the default voice can't speak: [Speaches](https://github.com/speaches-ai/speaches)
serving a Piper voice works. Speech goes to it when its language is known (a WhatsApp voice note
was spoken in it), or when the text has letters only that language uses (ı, ş, ğ for Turkish).

`ATC_STT_LANGUAGES` lets Whisper detect the language but keeps only those it lists: a clip heard as
anything else (short English, and Turkish too, come back as Icelandic or Portuguese) is transcribed in
each of them, and the first whose transcript uses letters plain English lacks (ç, ğ, ı) wins, else the
first listed. Pinned to Turkish, English speech still comes out as English, which is what tells the
two apart. It takes the place of `ATC_STT_LANGUAGE` when both are set. The language check knows Turkish
and English only.
