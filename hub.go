package main

import (
	"cmp"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/hub"
	"github.com/zcag/atc/internal/server"
	"github.com/zcag/atc/internal/startover"
	"github.com/zcag/atc/internal/when"
	"github.com/zcag/atc/modes"
)

func hubCmd(args []string) error {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		c := hub.NewClient(hubURL())
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		switch args[0] {
		case "status":
			st, err := c.Status(ctx)
			if err != nil {
				return err
			}
			alive := map[bool]string{true: "running", false: "not running"}[st.Alive]
			fmt.Printf("Session %s, %s (pid %d), context %dk, quiet %s, in %s.\n", st.Session, alive, st.PID, st.Context/1000,
				when.Duration(time.Duration(st.IdleS)*time.Second), st.Home)
			if len(st.Owners) > 0 {
				fmt.Printf("Its turn is for %s (writing to %s).\n", strings.Join(st.Owners, ", "), st.Route)
			}
			for ch, n := range st.Channels {
				fmt.Printf("Connected: %s (%d).\n", ch, n)
			}
			return nil
		case "reset":
			if err := c.Reset(ctx); err != nil {
				return err
			}
			fmt.Println("Starting over: the session writes its handover note, then a new one opens with it.")
			return nil
		}
		usageExit("hub")
	}
	fs := flags("hub")
	addr := fs.String("addr", cmp.Or(os.Getenv("ATC_HUB_ADDR"), "127.0.0.1:8820"), "listen address")
	model := fs.String("model", "opus", "Claude model")
	effort := fs.String("effort", "medium", "Claude effort")
	home, _ := os.UserHomeDir()
	state := fs.String("state", filepath.Join(home, ".local/state/atc/hub"), "where the session id and handover notes live")
	dir := fs.String("dir", server.DefaultAssistDir(), "the folder a new session starts in")
	guestState := fs.String("guest-state", filepath.Join(home, ".local/state/atc/guests"), "the guests' conversation's session id and handover notes")
	d := startover.Default
	quiet := fs.Duration("quiet", d.Quiet, "")
	small := fs.Int("small", d.Small, "")
	capQuiet := fs.Duration("cap-quiet", d.CapQuiet, "")
	cap := fs.Int("cap", d.Cap, "")
	fs.Parse(args)
	modes.Dir = filepath.Join(client.ConfigDir(), "modes")
	bin := cmp.Or(os.Getenv("ATC_CLAUDE_BIN"), "claude")
	cargs := append([]string{"--model", *model, "--effort", *effort}, server.HubArgs(*dir)...)
	cargs = append(cargs, strings.Fields(os.Getenv("ATC_HUB_CLAUDE_ARGS"))...)
	policy := startover.Policy{Quiet: *quiet, Small: *small, CapQuiet: *capQuiet, Cap: *cap}
	line := os.Getenv("ATC_CALL_LINE")
	gdir := filepath.Join(home, "guests")
	gargs := append([]string{"--model", *model, "--effort", *effort}, server.GuestsArgs(gdir)...)
	guests := hub.New(hub.Config{
		Bin: bin, Args: gargs, Dir: gdir, State: *guestState, Mode: guestsMode, Reset: policy,
		Call: hub.CallConfig{URL: line}, GuestDesk: true,
	})
	h := hub.New(hub.Config{
		Bin: bin, Args: cargs, Dir: *dir, State: *state, Mode: withLines(modes.Text), News: atcNews(), Reset: policy,
		Call:   hub.CallConfig{URL: line, Number: callNumber()},
		Guests: guests, OpenLine: client.Load().AgentLine, LineMode: withLines(lineMode),
	})
	for _, x := range []*hub.Hub{h, guests} {
		if x == h || x.HasConversation() {
			if err := x.Start(); err != nil {
				return err
			}
		}
		go x.Watch(context.Background(), time.Minute)
	}
	log.Printf("atc hub listening on http://%s", *addr)
	return http.ListenAndServe(*addr, h.Handler())
}

func guestsMode(ch string) string {
	if ch == hub.Agent {
		return modes.Text("guests-agent")
	}
	return modes.Text(ch)
}

// lineMode is how an agent's conversation talks while it is on a call or in its own WhatsApp group; the rest is as
// for any conversation.
func lineMode(ch string) string {
	switch ch {
	case hub.Phone:
		return modes.Text("line")
	case "whatsapp":
		return modes.Text("line-whatsapp")
	}
	return modes.Text(ch)
}

// withLines adds to the spoken mode who the call can move to, as of the call's start.
func withLines(mode func(string) string) func(string) string {
	return func(ch string) string {
		text := mode(ch)
		if ch != hub.Phone {
			return text
		}
		list, err := client.Load().Agents()
		if err != nil {
			log.Printf("hub: agents: %v", err)
			return text
		}
		var names []string
		for _, a := range list {
			if a.Talk {
				names = append(names, "@"+a.Name+" ("+cmp.Or(a.Title, a.Name)+")")
			}
		}
		if len(names) == 0 {
			return text + "\n- No agent can take the line right now."
		}
		return text + "\n- Agents who can take the line: " + strings.Join(names, ", ") + "."
	}
}

func atcNews() func(bool) string {
	c := client.Load()
	var seq int64
	return func(full bool) string {
		if c.Token == "" {
			c = client.Load()
		}
		text, next, err := c.Feed(seq, full)
		if err != nil {
			log.Printf("hub: atc feed: %v", err)
			return ""
		}
		seq = next
		return text
	}
}

func hubURL() string { return cmp.Or(os.Getenv("ATC_HUB"), "http://127.0.0.1:8820") }

func callNumber() string {
	if n := os.Getenv("ATC_CALL_NUMBER"); n != "" {
		return n
	}
	owner, _, _ := strings.Cut(os.Getenv("ATC_WHATSAPP_OWNER"), ",")
	if owner == "" || strings.Contains(owner, "@") {
		return ""
	}
	return "+" + strings.TrimPrefix(owner, "+")
}

func callCmd(args []string) error {
	var reason, via string
	var wait bool
	timeout := 45 * time.Second
	for i := 0; i < len(args); i++ {
		a := args[i]
		flag, v, inline := strings.Cut(strings.TrimLeft(a, "-"), "=")
		val := func() (string, error) {
			if inline {
				return v, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", a)
			}
			i++
			return args[i], nil
		}
		var err error
		switch {
		case !strings.HasPrefix(a, "-"):
			reason = strings.TrimSpace(reason + " " + a)
		case flag == "reason" || flag == "r":
			reason, err = val()
		case flag == "wait" || flag == "w":
			wait = true
		case flag == "app" || flag == "phone" || flag == "whatsapp":
			via = flag
		case flag == "timeout":
			var d string
			if d, err = val(); err == nil {
				timeout, err = time.ParseDuration(d)
			}
		default:
			return fmt.Errorf("unknown flag %s (atc call -h)", a)
		}
		if err != nil {
			return err
		}
	}
	c := client.Load()
	live, _ := c.Live()
	out, err := c.Call(map[string]any{"reason": reason, "wait": wait, "timeout": int(timeout.Seconds()), "via": via,
		"from": client.From(live, client.Sign{Report: true}), "session": os.Getenv("CLAUDE_CODE_SESSION_ID")})
	if err != nil {
		return err
	}
	switch out {
	case "dialing":
		fmt.Println("Calling. When they pick up, the assistant talks to them; if nobody answers, this session hears about it.")
	case hub.Answered:
		fmt.Println("answered: the assistant is talking to them")
	default:
		fmt.Println(out)
	}
	return nil
}
