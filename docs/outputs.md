# Outputs

Each session has an **Outputs** tab with what it produced, so you can check its work from a phone:

- **Pages** it showed you, with previews.
- **Running:** servers the session started (a dev server, a preview), as links on the machine's
  name. A server that listens only on localhost is marked as such, since it opens only on that
  machine. Running servers also show on the session's strip.
- **Files** it wrote, plus images, pages, notes, PDFs and media it mentioned or looked at, with
  previews. Tap one to view it: images, pages (with their stylesheets and scripts, sandboxed),
  rendered Markdown, video and audio, and plain text for code.
- **Links** it gave in its replies.
- **Code it touched**, newest first, readable in place.

Files open through links that are signed for that session and folder and expire after 12 hours,
and pages run sandboxed, away from atc's own login. `atc outputs <session>` prints the same.
