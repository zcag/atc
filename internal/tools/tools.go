package tools

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/history"
	"github.com/zcag/atc/internal/sessions"
)

const instructions = `These tools see and drive the user's other Claude Code sessions, the ones atc manages on their machines. ` +
	`Use them when the user talks about another session, project or task by name: "sessions" to see what is open and what each is doing, ` +
	`"read" before you summarize or answer about a session, "send" to pass on what the user wants, "wait" when they want the result, ` +
	`"start" for new work in a folder. Refer to sessions by their title. Never send to the session marked as you.`

type Session struct {
	Ref        string `json:"ref" jsonschema:"what to pass as session to the other tools"`
	Title      string `json:"title"`
	State      string `json:"state" jsonschema:"needs-you, your-turn, working, stopped or past"`
	Host       string `json:"host,omitempty"`
	Dir        string `json:"dir"`
	Running    bool   `json:"running" jsonschema:"true when it runs in the background and can take messages"`
	InTerminal bool   `json:"inTerminal,omitempty" jsonschema:"open in someone's terminal: readable, cannot take messages"`
	Parked     bool   `json:"parked,omitempty"`
	You        bool   `json:"you,omitempty" jsonschema:"this is the session calling the tool"`
	Doing      string `json:"doing,omitempty" jsonschema:"what it is doing right now, while working"`
	Asked      string `json:"asked,omitempty" jsonschema:"the last thing the user asked it"`
	Replied    string `json:"replied,omitempty" jsonschema:"the start of its last reply"`
	Since      string `json:"since,omitempty"`
}

type list struct {
	Sessions []Session `json:"sessions"`
}

type ref struct {
	Session string `json:"session" jsonschema:"a session ref, short id, or a unique piece of its title"`
}

type readIn struct {
	Session  string `json:"session" jsonschema:"a session ref, short id, or a unique piece of its title"`
	Messages int    `json:"messages,omitempty" jsonschema:"how many recent messages to return, default 20"`
}

type sendIn struct {
	Session string `json:"session" jsonschema:"a session ref, short id, or a unique piece of its title"`
	Text    string `json:"text" jsonschema:"the message, typed into the session as if the user wrote it"`
}

type startIn struct {
	Dir      string `json:"dir" jsonschema:"folder on that machine, ~ allowed"`
	Prompt   string `json:"prompt" jsonschema:"the first message"`
	Name     string `json:"name,omitempty" jsonschema:"short title; without one Claude titles it"`
	Host     string `json:"host,omitempty" jsonschema:"machine name from the sessions list; default the main one"`
	Worktree bool   `json:"worktree,omitempty" jsonschema:"work in its own git worktree so it cannot clash with other sessions in the repo"`
}

type waitIn struct {
	Session string `json:"session" jsonschema:"a session ref, short id, or a unique piece of its title"`
	Seconds int    `json:"seconds,omitempty" jsonschema:"how long to wait at most, default 300, max 900"`
}

type historyIn struct {
	Query string `json:"query,omitempty" jsonschema:"words from the title, prompts or folder"`
	Limit int    `json:"limit,omitempty" jsonschema:"default 15"`
}

type done struct {
	Ref     string `json:"ref,omitempty"`
	Title   string `json:"title,omitempty"`
	State   string `json:"state,omitempty"`
	Replied string `json:"replied,omitempty"`
	Note    string `json:"note,omitempty"`
}

type transcript struct {
	Title    string `json:"title"`
	State    string `json:"state"`
	Messages string `json:"messages"`
}

func Run(ctx context.Context, c *client.Client) error {
	s := mcp.NewServer(&mcp.Implementation{Name: "atc", Version: "1"}, &mcp.ServerOptions{Instructions: instructions})
	t := &tools{c: c, self: os.Getppid()}

	mcp.AddTool(s, &mcp.Tool{Name: "sessions", Description: "List the user's open Claude Code sessions on all their machines, most urgent first, with what each is doing."},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, list, error) {
			live, err := c.Live()
			if err != nil {
				return nil, list{}, err
			}
			out := list{Sessions: []Session{}}
			for _, x := range live {
				out.Sessions = append(out.Sessions, t.view(x))
			}
			return nil, out, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "read", Description: "Read the recent conversation of a session (open or past): what was asked, what it answered, which tools it ran."}, t.read)
	mcp.AddTool(s, &mcp.Tool{Name: "send", Description: "Type a message into a running session, as if the user wrote it there. A stopped or past session is resumed first. Returns right away; use wait for the answer."}, t.send)
	mcp.AddTool(s, &mcp.Tool{Name: "wait", Description: "Wait until a session finishes its turn or needs the user, then return the start of its reply."}, t.wait)
	mcp.AddTool(s, &mcp.Tool{Name: "start", Description: "Start a new background session in a folder with a first message."}, t.start)
	mcp.AddTool(s, &mcp.Tool{Name: "stop", Description: "Stop a running session. Its conversation is kept and can be resumed."}, t.stop)
	mcp.AddTool(s, &mcp.Tool{Name: "history", Description: "Search earlier conversations by title, prompts or folder, newest first."}, t.history)
	return s.Run(ctx, &mcp.StdioTransport{})
}

type tools struct {
	c    *client.Client
	self int
}

func (t *tools) view(x sessions.Session) Session {
	v := Session{
		Ref: x.SessionID, Title: x.Title, State: x.State, Host: x.Host, Dir: x.Cwd, Running: x.Attachable,
		InTerminal: x.Kind == "interactive", Parked: x.Parked, You: t.self > 0 && x.PID == t.self,
		Asked: clip(x.LastPrompt, 200), Replied: clip(x.LastReply, 300),
	}
	if x.ID != "" {
		v.Ref = x.ID
	}
	if x.State == sessions.Working {
		v.Doing = x.Activity
	}
	if at := x.Last(); !at.IsZero() {
		v.Since = at.Format(time.RFC3339)
	}
	return v
}

func (t *tools) find(q string, past bool) (sessions.Session, error) {
	return t.c.Find(q, past)
}

func (t *tools) read(ctx context.Context, _ *mcp.CallToolRequest, in readIn) (*mcp.CallToolResult, transcript, error) {
	x, err := t.find(in.Session, true)
	if err != nil {
		return nil, transcript{}, err
	}
	p, err := t.c.Transcript(x.SessionID)
	if err != nil {
		return nil, transcript{}, err
	}
	n := in.Messages
	if n <= 0 {
		n = 20
	}
	return nil, transcript{x.Title, x.State, render(p.Messages, n)}, nil
}

func render(msgs []history.Message, n int) string {
	var talk []history.Message
	for _, m := range msgs {
		if m.Role == "user" || m.Role == "assistant" {
			talk = append(talk, m)
		}
	}
	from := 0
	if len(talk) > n {
		from = len(talk) - n
	}
	start := 0
	if from > 0 {
		first := talk[from]
		for i, m := range msgs {
			if m == first {
				start = i
				break
			}
		}
	}
	var b strings.Builder
	tools := 0
	flush := func() {
		if tools > 0 {
			fmt.Fprintf(&b, "  (%d tool calls)\n", tools)
			tools = 0
		}
	}
	for _, m := range msgs[start:] {
		switch m.Role {
		case "tool":
			tools++
		case "user":
			flush()
			fmt.Fprintf(&b, "USER: %s\n", clip(m.Text, 2000))
		case "assistant":
			flush()
			fmt.Fprintf(&b, "CLAUDE: %s\n", clip(m.Text, 4000))
		}
	}
	flush()
	return b.String()
}

func (t *tools) send(ctx context.Context, _ *mcp.CallToolRequest, in sendIn) (*mcp.CallToolResult, done, error) {
	x, err := t.find(in.Session, true)
	if err != nil {
		return nil, done{}, err
	}
	if t.self > 0 && x.PID == t.self {
		return nil, done{}, fmt.Errorf("that is this session itself")
	}
	if x.Kind == "interactive" && x.PID > 0 {
		return nil, done{}, fmt.Errorf("%q is open in a terminal, so it cannot take messages from here; the user has to type into it there", x.Title)
	}
	id, note := x.ID, ""
	if !x.Attachable {
		if id, err = t.c.Resume(x.SessionID); err != nil {
			return nil, done{}, fmt.Errorf("resume %q: %w", x.Title, err)
		}
		if err := t.until(ctx, id, 30*time.Second, func(s sessions.Session) bool { return s.Attachable }); err != nil {
			return nil, done{}, err
		}
		note = "resumed it first"
	}
	if err := t.c.Send(id, in.Text); err != nil {
		return nil, done{}, err
	}
	return nil, done{Ref: id, Title: x.Title, State: "sent", Note: note}, nil
}

func (t *tools) wait(ctx context.Context, _ *mcp.CallToolRequest, in waitIn) (*mcp.CallToolResult, done, error) {
	x, err := t.find(in.Session, false)
	if err != nil {
		return nil, done{}, err
	}
	secs := in.Seconds
	if secs <= 0 {
		secs = 300
	}
	key := x.ID
	if key == "" {
		key = x.SessionID
	}
	time.Sleep(3 * time.Second)
	var last sessions.Session
	err = t.until(ctx, key, time.Duration(min(secs, 900))*time.Second, func(s sessions.Session) bool {
		last = s
		return s.State != sessions.Working
	})
	if err != nil {
		return nil, done{Ref: key, Title: x.Title, State: last.State, Note: "still working: " + last.Activity}, nil
	}
	return nil, done{Ref: key, Title: last.Title, State: last.State, Replied: clip(last.LastReply, 1500)}, nil
}

func (t *tools) until(ctx context.Context, key string, limit time.Duration, ok func(sessions.Session) bool) error {
	end := time.Now().Add(limit)
	for {
		live, err := t.c.Live()
		if err == nil {
			for _, s := range live {
				if (s.ID == key || s.SessionID == key) && ok(s) {
					return nil
				}
			}
		}
		if time.Now().After(end) {
			return fmt.Errorf("gave up after %s", limit)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func (t *tools) start(ctx context.Context, _ *mcp.CallToolRequest, in startIn) (*mcp.CallToolResult, done, error) {
	id, err := t.c.StartOn(in.Host, in.Dir, in.Name, in.Prompt, in.Worktree)
	if err != nil {
		return nil, done{}, err
	}
	return nil, done{Ref: id, Title: in.Name, State: "started"}, nil
}

func (t *tools) stop(ctx context.Context, _ *mcp.CallToolRequest, in ref) (*mcp.CallToolResult, done, error) {
	x, err := t.find(in.Session, false)
	if err != nil {
		return nil, done{}, err
	}
	if !x.Attachable {
		return nil, done{}, fmt.Errorf("%q is not running in the background", x.Title)
	}
	if t.self > 0 && x.PID == t.self {
		return nil, done{}, fmt.Errorf("that is this session itself")
	}
	return nil, done{Ref: x.ID, Title: x.Title, State: "stopped"}, t.c.Stop(x.ID)
}

func (t *tools) history(ctx context.Context, _ *mcp.CallToolRequest, in historyIn) (*mcp.CallToolResult, list, error) {
	n := in.Limit
	if n <= 0 {
		n = 15
	}
	past, err := t.c.History(in.Query, "", n)
	if err != nil {
		return nil, list{}, err
	}
	out := list{Sessions: []Session{}}
	for _, x := range past {
		out.Sessions = append(out.Sessions, t.view(x))
	}
	return nil, out, nil
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}
