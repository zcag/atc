package main

import (
	"cmp"
	"context"
	"flag"
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
	"github.com/zcag/atc/modes"
)

const hubHelp = `atc hub: the assistant's one conversation, shared by atc, WhatsApp and phone calls.

  atc hub [-addr 127.0.0.1:8820] [-model opus] [-effort low] [-state DIR]
  atc hub status | reset

Runs Claude as a stream-json process that each channel talks into, so a reply streams to
whoever asked while the others wait or join. Runs as its own service (atc-hub.service), so
restarting atc never cuts a call. atc finds it at $ATC_HUB.

  -quiet 6h -small 80000      quiet this long and past this many tokens: start over
  -cap-quiet 10m -cap 150000  quiet this long and past this many: start over
Starting over has the session write a handover note that opens the next one.

Calls go through delta-call at $ATC_DELTA_CALL (http://127.0.0.1:8807) and only ever to
$ATC_CALL_NUMBER (default: the first number in $ATC_WHATSAPP_OWNER).
Mode files (how to talk on each channel) override from ~/.config/atc/modes/<channel>.md.
`

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
			fmt.Printf("session %s, pid %d, alive %v, context %dk, quiet %s, home %s\n", st.Session, st.PID, st.Alive, st.Context/1000,
				(time.Duration(st.IdleS) * time.Second).String(), st.Home)
			if len(st.Owners) > 0 {
				fmt.Printf("turn for %s (writing to %s)\n", strings.Join(st.Owners, ", "), st.Route)
			}
			for ch, n := range st.Channels {
				fmt.Printf("connected: %s (%d)\n", ch, n)
			}
			return nil
		case "reset":
			if err := c.Reset(ctx); err != nil {
				return err
			}
			fmt.Println("Starting over: the session writes its handover note, then a new one opens with it.")
			return nil
		}
		fmt.Print(hubHelp)
		os.Exit(2)
	}
	fs := flag.NewFlagSet("hub", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(hubHelp) }
	addr := fs.String("addr", cmp.Or(os.Getenv("ATC_HUB_ADDR"), "127.0.0.1:8820"), "listen address")
	model := fs.String("model", "opus", "Claude model")
	effort := fs.String("effort", "low", "Claude effort")
	home, _ := os.UserHomeDir()
	state := fs.String("state", filepath.Join(home, ".local/state/atc/hub"), "where the session id and handover notes live")
	dir := fs.String("dir", home, "the folder the session works in")
	d := startover.Default
	quiet := fs.Duration("quiet", d.Quiet, "")
	small := fs.Int("small", d.Small, "")
	capQuiet := fs.Duration("cap-quiet", d.CapQuiet, "")
	cap := fs.Int("cap", d.Cap, "")
	fs.Parse(args)
	modes.Dir = filepath.Join(client.ConfigDir(), "modes")
	bin := cmp.Or(os.Getenv("ATC_CLAUDE_BIN"), "claude")
	cargs := append([]string{"--model", *model, "--effort", *effort}, server.HubArgs()...)
	cargs = append(cargs, strings.Fields(os.Getenv("ATC_HUB_CLAUDE_ARGS"))...)
	h := hub.New(hub.Config{
		Bin: bin, Args: cargs, Dir: *dir, State: *state, Mode: modes.Text,
		Reset: startover.Policy{Quiet: *quiet, Small: *small, CapQuiet: *capQuiet, Cap: *cap},
		Call:  hub.CallConfig{URL: cmp.Or(os.Getenv("ATC_DELTA_CALL"), "http://127.0.0.1:8807"), Number: callNumber()},
	})
	if err := h.Start(); err != nil {
		return err
	}
	go h.Watch(context.Background(), time.Minute)
	log.Printf("atc hub listening on http://%s", *addr)
	return http.ListenAndServe(*addr, h.Handler())
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

const callHelp = `atc call: have delta ring the user, with the assistant on the line.

  atc call [--reason TEXT] [--wait] [--timeout 45s] [--whatsapp]

delta (the agents' phone line) calls the user's own number, never another. When they pick
up, the assistant (atc's hub session) speaks first and knows the reason; from another
session, it also knows who asked and passes their answer back to you with send.

  --reason TEXT   why you are calling and what to tell them
  --wait          wait for the outcome and print it: answered, no-answer or busy
  --timeout D     how long it rings (default 45s)
  --whatsapp      a WhatsApp voice call from delta's bot account instead of the phone line;
                  only when the user asks for a WhatsApp call

Without --wait it returns at once; a call nobody picks up comes back to your session as
a "[telefon ... açmadı]" message.
`

func callCmd(args []string) error {
	var reason string
	var wait, whatsapp bool
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
		case flag == "h" || flag == "help":
			fmt.Print(callHelp)
			return nil
		case flag == "reason" || flag == "r":
			reason, err = val()
		case flag == "wait" || flag == "w":
			wait = true
		case flag == "whatsapp":
			whatsapp = true
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
	out, err := c.Call(map[string]any{"reason": reason, "wait": wait, "timeout": int(timeout.Seconds()), "whatsapp": whatsapp,
		"from": client.From(live, false, true), "session": os.Getenv("CLAUDE_CODE_SESSION_ID")})
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
