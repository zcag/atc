# Resources

**Resources** (command palette, or `mem` in the console line and on the phone's board) shows what
agents cost each machine, with sessions totalled per bay; `atc top` prints the same. A session's
State pane shows what it spends on by what it runs (the app, Claude, the browser tool), six hours of
history, and what its worktree holds. Secrets in command lines are hidden. Every 10 seconds atc
attributes every process to one of:

- **a session**: the Claude process and everything below it, found through the process tree.
- **outlived its session**: still running after its session ended, which can be deliberate (a dev
  stack other sessions use). A process that lost its parent still names its session in
  `CLAUDE_JOB_DIR`, `CLAUDE_CODE_SESSION_ID` or a job folder in its arguments, and its children
  inherit that. Anything else in Claude's systemd scope that is not Claude counts too, as "Session
  unknown".
- **outside**: containers and services, one row per cgroup.

Memory is PSS for sessions, so a page shared by ten processes counts a tenth in each; for outside
rows it is the cgroup's own count minus reclaimable cache (what `docker stats` shows), since
Postgres's RSS would add up to more than the machine has. CPU includes children that have already
exited, through the kernel's `cutime`, so a test run that came and went between two samples still
counts. Disk rates cover processes alive at the sample. On macOS there is no `/proc`: memory is RSS,
and disk rates and orphan attribution by environment are missing.

Files in `/tmp` and `/dev/shm` are memory too when those are tmpfs, and no process owns them, so they
get their own number and a list of the biggest folders in `/tmp`.

A point a minute goes to `~/.config/atc/resources/`, kept for a week, with the biggest processes of
anything over 500 MB or 10% of a core. Clicking a chart shows that moment. Disk use of the repos and
worktrees sessions work in is added up hourly at idle priority. A session's row carries its load only
over 1 GB or a full core.
