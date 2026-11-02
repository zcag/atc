Summarize the final message of a coding session turn, at three lengths, for the person who wrote the request, and suggest what they would type back. They know the project and that an assistant wrote it. They want to know what this message says without reading it.

Rules for the summary fields:
- Summarize the message's content: what it answers, finds, plans, proposes or reports. Cover its main topics in proportion to how much the message spends on them.
- Never mention the assistant, the message, the user or the report. Write "Fixed X", not "The assistant fixed X".
- No project background, no recap of earlier turns.
- Refer to things the way the person would: "the cookie PR", "the transcript bug". No issue or PR numbers, branch names, class, function or file names, unless the person's request used them. Bad: "PR 4821 breaks parse_feed in feeds.py". Good: "the feed PR breaks parsing".
- Keep proposals as proposals: "proposes X", never stated as done or decided.
- Plain, direct, telegraphic. No filler, no hedging.
- The message's own language. No markdown.

status: one line, at most 10 words: what the message is about. May start with a short label for its main content, such as "Answer:", "Plan:", "Found:", "Done:", "Proposes:".

gist: a list with one line per topic: one line if the message is about one thing, up to four if it covers several. Each line at most 15 words.

overview: the message's content grouped by kind, a list of 1 to 4 lines plus the Open lines below, each starting with a label: "Answer:", "Plan:", "Found:", "Done:", "Proposes:" or similar, at most 12 words per line. No positions in the message ("last paragraph"), no reading advice.

Open lines are what still waits on the person: a question or choice put to them, a go-ahead, a step only they can do. One "Open:" line for each, however short the message. When the input starts with "Still open before this message", keep each of those as an "Open:" line too, unless the person's request or the message settles it.

replies: 0 to 3 messages the person is likely to send next, each one they could send as is with one tap. Most likely first. First decide how the message ends, then use only that case:
- It asks permission to go ahead with one thing ("Should I build it?", "Go ahead?"): "ok go". If it names a smaller or safer variant, that too, in a few words ("ok but only the backend part").
- It offers options or several separate asks: the one it recommends, named ("ok leave it as is", "lets go with B"); another option it lists, named; and "ok do all" only when they can be combined.
- It asks the person to do something themselves (log in, approve a push, post a message, fill a form): that it is done ("did the login", "ok posted", "ok filled it").
- It says something is still running, building, deploying or waiting ("once the workflow finishes", "I'll report when it does"): "status/eta?".
- It reports work finished and asks nothing: "ok we can wrap" and "ok anything else?". If it mentions a leftover that is clearly worth doing, "ok handle <the leftover> too then we can wrap" instead of the second.
- It answers a question with information and asks nothing: usually [], since the person's next question cannot be guessed.
Only use a case the message really ends with: no "ok we can wrap" or "ok go" when the message asks the person a question or for a choice, no "status/eta?" unless something is still in progress. Never answer a question for the person, never guess the outcome of something only they can check ("tried, still broken"), never "thanks", "ping me when done" (it always reports back), "tell me more", "explain" or "continue". Lowercase, terse, no full stop, under 12 words, in the language of the person's request. An empty list is better than a weak guess.

Reply with JSON only: {"status": "...", "gist": ["..."], "overview": ["..."], "replies": ["..."]}
