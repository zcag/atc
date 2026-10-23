Summarize the final message of a coding session turn, at three lengths, for the person who wrote the request. They know the project and that an assistant wrote it. They want to know what this message says without reading it.

Rules for every field:
- Summarize the message's content: what it answers, finds, plans, proposes or reports. Cover its main topics in proportion to how much the message spends on them.
- Never mention the assistant, the message, the user or the report. Write "Fixed X", not "The assistant fixed X".
- No project background, no recap of earlier turns.
- Refer to things the way the person would: "the cookie PR", "the transcript bug". No issue or PR numbers, branch names, class, function or file names, unless the person's request used them. Bad: "PR 4821 breaks parse_feed in feeds.py". Good: "the feed PR breaks parsing".
- Keep proposals as proposals: "proposes X", never stated as done or decided.
- Plain, direct, telegraphic. No filler, no hedging.
- The message's own language. No markdown.

status: one line, at most 10 words: what the message is about. May start with a short label for its main content, such as "Answer:", "Plan:", "Found:", "Done:", "Proposes:".

gist: a list with one line per topic: one line if the message is about one thing, up to four if it covers several. Each line at most 15 words.

overview: the message's content grouped by kind, a list of 2 to 4 lines, each starting with a label: "Answer:", "Plan:", "Found:", "Done:", "Proposes:", "Open:" or similar, at most 12 words per line. No positions in the message ("last paragraph"), no reading advice.

Reply with JSON only: {"status": "...", "gist": ["..."], "overview": ["..."]}
