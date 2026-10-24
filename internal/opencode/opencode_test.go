package opencode

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zcag/atc/internal/outputs"
)

const session = `{"id":"ses_a","directory":"/home/u/app","title":"Fix login","model":{"id":"qwen","providerID":"mlx"},"time":{"created":1000,"updated":5000}}`

const messages = `[
 {"info":{"id":"msg_1","role":"user","time":{"created":1000}},"parts":[{"type":"text","text":"brief","synthetic":true},{"type":"text","text":"fix the login page"}]},
 {"info":{"id":"msg_2","role":"assistant","modelID":"qwen","providerID":"mlx","time":{"created":2000,"completed":4000},"tokens":{"input":900,"output":40,"cache":{"read":100,"write":0}}},
  "parts":[{"type":"step-start"},{"type":"text","text":"Writing it."},
   {"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"/home/u/app/shot.png","content":"x"},"time":{"start":2500}}},
   {"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"python -m http.server 8123","description":"Serve it"},"output":"see http://pages.example/page\n"}}]},
 {"info":{"id":"msg_3","role":"assistant","modelID":"qwen","providerID":"mlx","time":{"created":4000,"completed":4500},"tokens":{"input":1000,"output":10,"cache":{"read":0,"write":0}}},
  "parts":[{"type":"text","text":"Done: the login page works."}]}
]`

func decode(t *testing.T) (Session, []Message) {
	var s Session
	var ms []Message
	if err := json.Unmarshal([]byte(session), &s); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(messages), &ms); err != nil {
		t.Fatal(err)
	}
	return s, ms
}

func TestTranscript(t *testing.T) {
	s, ms := decode(t)
	tr := Transcript(s, ms)
	if tr.SessionID != "ses_a" || tr.Harness != Harness || tr.Cwd != "/home/u/app" || tr.Title != "Fix login" ||
		tr.LastPrompt != "fix the login page" || tr.Model != "mlx/qwen" || tr.Context != 1000 ||
		tr.LastReply != "Done: the login page works." || tr.ReplyID != "msg_3" || tr.Activity != "" || tr.PromptAt.UnixMilli() != 1000 {
		t.Fatalf("unexpected %+v", tr)
	}
	tr = Transcript(s, ms[:2])
	if tr.Activity != "Bash  Serve it" {
		t.Fatalf("activity of a turn still in its tools: %q", tr.Activity)
	}
	if text, _ := Reply(ms, "msg_2"); text != "Writing it." {
		t.Fatalf("reply %q", text)
	}
}

func TestMessages(t *testing.T) {
	_, ms := decode(t)
	var got []string
	for _, m := range Messages(ms) {
		got = append(got, m.Role+":"+m.Tool+":"+m.Text+m.Detail)
	}
	want := "user::fix the login page|assistant::Writing it.|tool:Write:/home/u/app/shot.png|tool:Bash:Serve it|assistant::Done: the login page works."
	if strings.Join(got, "|") != want {
		t.Fatalf("got  %s\nwant %s", strings.Join(got, "|"), want)
	}
}

func TestStepsFeedOutputs(t *testing.T) {
	_, ms := decode(t)
	_, links, ports := outputs.Collect(Steps(ms), "/home/u", nil)
	if _, ok := ports["8123"]; !ok {
		t.Fatalf("server port not seen: %v", ports)
	}
	if len(links) != 0 {
		t.Fatalf("tool output links need a featured match: %v", links)
	}
	steps := Steps(ms)
	if steps[1].Tool != "Write" || steps[1].Path != "/home/u/app/shot.png" {
		t.Fatalf("write step %+v", steps[1])
	}
}

func TestUsage(t *testing.T) {
	_, ms := decode(t)
	u := Usage(ms)
	if u.Turns != 1 || u.ToolCalls != 2 || u.Input != 1900 || u.Output != 50 || u.CacheRead != 100 || u.Cost != 0 ||
		len(u.Local) != 1 || u.Local[0] != "mlx/qwen" || u.Active != 2 || u.Messages != 2 {
		t.Fatalf("unexpected %+v", u)
	}
}

func TestMergeReplacesTheChangedTail(t *testing.T) {
	_, ms := decode(t)
	changed := ms[2]
	changed.Parts = append(changed.Parts, Part{Type: "text", Text: "more"})
	got, ok := merge(ms, []Message{changed})
	if !ok || len(got) != 3 || len(got[2].Parts) != 2 || len(ms[2].Parts) != 1 {
		t.Fatalf("merge: ok=%v len=%d", ok, len(got))
	}
	if _, ok := merge(ms[:1], []Message{ms[2]}); ok {
		t.Fatal("a tail that does not overlap must refetch")
	}
}

func TestLive(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/session/ses_a":
			w.Write([]byte(session))
		case "/session/ses_gone":
			http.NotFound(w, r)
		case "/session/ses_a/message":
			w.Write([]byte(messages))
		case "/session/status":
			w.Write([]byte(`{"ses_a":{"type":"busy"}}`))
		case "/question":
			w.Write([]byte(`[{"sessionID":"ses_a","questions":[{"question":"Which port?","options":[{"label":"8080"},{"label":"9090"}]}]}]`))
		case "/permission":
			w.Write([]byte(`[]`))
		case "/vcs":
			if r.URL.Query().Get("directory") != "/home/u/app" {
				t.Errorf("vcs asked for %q", r.URL.Query().Get("directory"))
			}
			w.Write([]byte(`{"branch":"login-fix"}`))
		default:
			t.Errorf("unexpected %s", r.URL)
		}
	}))
	defer srv.Close()
	b := New(srv.URL, "opencode")
	live, gone := b.Live(context.Background(), []string{"ses_a", "ses_gone"})
	if len(gone) != 1 || gone[0] != "ses_gone" {
		t.Fatalf("gone %v", gone)
	}
	if len(live) != 1 || !live[0].Busy || len(live[0].Asks) != 1 || live[0].Asks[0].Activity() != "AskUserQuestion  Which port? (8080 · 9090)" || live[0].Branch != "login-fix" {
		t.Fatalf("live %+v", live)
	}
	cmd := b.Attach("ses_a")
	if got := strings.Join(cmd.Args, " "); got != "opencode attach "+srv.URL+" --session ses_a --dir /home/u/app" {
		t.Fatalf("attach %q", got)
	}
}
