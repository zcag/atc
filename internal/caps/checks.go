package caps

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func command(ctx context.Context, bin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.WaitDelay = time.Second
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

func notInstalled(err error) bool {
	return errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission)
}

var version = regexp.MustCompile(`\d+(\.\d+)+`)

func older(have, want string) bool {
	h, w := strings.Split(have, "."), strings.Split(want, ".")
	for i := range min(len(h), len(w)) {
		a, _ := strconv.Atoi(h[i])
		b, _ := strconv.Atoi(w[i])
		if a != b {
			return a < b
		}
	}
	return len(h) < len(w)
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	if len(line) > 160 {
		line = line[:160] + "..."
	}
	return line
}

func checkClaude(ctx context.Context, env Env) Result {
	out, err := command(ctx, env.Bin, "--version")
	if notInstalled(err) {
		return Result{Missing, fmt.Sprintf("Not installed: %s was not found on this machine's PATH.", env.Bin)}
	}
	if err != nil {
		return Result{Broken, "claude --version failed: " + firstLine(out)}
	}
	v := version.FindString(out)
	if v != "" && older(v, MinClaude) {
		return Result{Broken, fmt.Sprintf("Version %s is too old: atc needs background sessions, which start at %s.", v, MinClaude)}
	}
	if out, err := command(ctx, env.Bin, "agents", "--json"); err != nil {
		return Result{Broken, "claude agents failed, so atc can't list sessions: " + firstLine(out)}
	}
	return Result{OK, "Version " + v + "."}
}

func checkSignin(ctx context.Context, env Env) Result {
	out, err := command(ctx, env.Bin, "auth", "status")
	if notInstalled(err) {
		return Result{Missing, "Waits for Claude Code to be installed."}
	}
	var st struct {
		LoggedIn         bool   `json:"loggedIn"`
		AuthMethod       string `json:"authMethod"`
		SubscriptionType string `json:"subscriptionType"`
	}
	if json.Unmarshal([]byte(out), &st) != nil {
		if err != nil {
			return Result{Missing, "Not signed in: " + firstLine(out)}
		}
		return Result{OK, "Signed in."}
	}
	if !st.LoggedIn {
		return Result{Missing, "Not signed in."}
	}
	if st.SubscriptionType != "" {
		return Result{OK, fmt.Sprintf("Signed in with %s, %s plan.", st.AuthMethod, st.SubscriptionType)}
	}
	return Result{OK, "Signed in with " + st.AuthMethod + "."}
}

var httpc = &http.Client{Transport: &http.Transport{DisableKeepAlives: true, Proxy: http.ProxyFromEnvironment}}

func fetch(ctx context.Context, u string, hdr ...string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return 0, nil, err
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	res, err := httpc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, b, nil
}

// site is the part of an address safe to show: no credentials, path or query.
func site(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "that address"
	}
	return u.Scheme + "://" + u.Host
}

// shown is a setting's value as the page may see it: an address carrying credentials or a query loses them.
func shown(f Field, v string) string {
	if u, err := url.Parse(v); f.URL && v != "" && (err != nil || u.User != nil || u.RawQuery != "") {
		return site(v)
	}
	return v
}

func untrusted(err error) bool {
	var v *tls.CertificateVerificationError
	return errors.As(err, &v)
}

// inWords says why a request failed without repeating the address, which can carry a secret.
func inWords(err error) string {
	var dns *net.DNSError
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		return "no answer in time"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "nothing is listening there"
	case errors.As(err, &dns):
		return "that name does not resolve"
	case untrusted(err):
		return "this machine does not trust its certificate"
	}
	return "could not connect"
}

func down(raw string, err error) Result {
	return Result{Broken, fmt.Sprintf("Set to %s, but %s.", site(raw), inWords(err))}
}

// urlCheck is for a service only reachability can be checked on without spending anything: a GET on a POST route
// answers 404 or 405, which still says the service is up.
func urlCheck(key, off string) func(context.Context, Env) Result {
	return func(ctx context.Context, env Env) Result {
		u := env.Get(key)
		if u == "" {
			return Result{Missing, "Not set up. " + off}
		}
		code, _, err := fetch(ctx, u)
		if err != nil {
			return down(u, err)
		}
		if code >= 500 {
			return Result{Broken, fmt.Sprintf("%s answers with an error (%d).", site(u), code)}
		}
		return Result{OK, site(u) + " answers."}
	}
}

func checkServer(ctx context.Context, env Env) Result {
	if env.Self == "" {
		return Result{OK, "Running."}
	}
	code, _, err := fetch(ctx, env.Self+"/healthz")
	if err != nil {
		return Result{Broken, fmt.Sprintf("Nothing answers at %s: %s.", site(env.Self), inWords(err))}
	}
	if code != 200 {
		return Result{Broken, fmt.Sprintf("%s answers with %d.", site(env.Self), code)}
	}
	return Result{OK, "Running at " + site(env.Self) + "."}
}

func checkReach(ctx context.Context, env Env) Result {
	u := env.Get("ATC_PUBLIC_URL")
	if u == "" {
		return Result{Missing, "No address set: links in messages and pushes have nowhere to point, and browsers won't give this page the microphone over plain HTTP."}
	}
	code, _, err := fetch(ctx, strings.TrimRight(u, "/")+"/healthz")
	if untrusted(err) {
		return Result{OK, site(u) + " answers, but this machine does not trust its certificate. If it is your own CA, each device needs it too."}
	}
	if err != nil {
		return down(u, err)
	}
	if code != 200 {
		return Result{Broken, fmt.Sprintf("%s answers with %d, not atc's own answer.", site(u), code)}
	}
	if strings.HasPrefix(u, "http://") {
		return Result{OK, site(u) + " answers over plain HTTP, so browsers won't give this page the microphone."}
	}
	return Result{OK, site(u) + " answers."}
}

func checkHub(ctx context.Context, env Env) Result {
	u := env.Get("ATC_HUB")
	if u == "" {
		return Result{Missing, "Not set up: the assistant runs as an ordinary session, without WhatsApp or calls."}
	}
	code, b, err := fetch(ctx, strings.TrimRight(u, "/")+"/status")
	if err != nil {
		return down(u, err)
	}
	var st struct {
		Alive bool `json:"alive"`
	}
	if code != 200 || json.Unmarshal(b, &st) != nil {
		return Result{Broken, fmt.Sprintf("%s answers, but not as a hub (%d).", site(u), code)}
	}
	if !st.Alive {
		return Result{OK, "Running, and asleep until the next message."}
	}
	return Result{OK, "Running, with its conversation open."}
}

type callStatus struct {
	Bridge  string         `json:"bridge"`
	Talkers map[string]int `json:"talkers"`
}

func callLine(ctx context.Context, u string) (callStatus, error) {
	var st callStatus
	code, b, err := fetch(ctx, strings.TrimRight(u, "/")+"/status")
	if err != nil {
		return st, err
	}
	if code != 200 {
		return st, fmt.Errorf("status %d", code)
	}
	return st, json.Unmarshal(b, &st)
}

func checkCallLine(ctx context.Context, env Env) Result {
	u := env.Get("ATC_CALL_LINE")
	if u == "" {
		return Result{Missing, "Not set up: nothing can carry a call."}
	}
	if _, err := callLine(ctx, u); err != nil {
		return down(u, err)
	}
	return Result{OK, site(u) + " answers."}
}

func checkTalker(ctx context.Context, env Env) Result {
	u := env.Get("ATC_CALL_LINE")
	if u == "" {
		return Result{Missing, "Waits for the call line."}
	}
	st, err := callLine(ctx, u)
	if err != nil {
		return Result{Missing, "Can't tell while the call line is not answering."}
	}
	n := 0
	for _, c := range st.Talkers {
		n += c
	}
	if n == 0 {
		return Result{Broken, "No talker is connected to the call line, so a call would find nobody."}
	}
	return Result{OK, fmt.Sprintf("%d connected to the call line.", n)}
}

func checkVoices(ctx context.Context, env Env) Result {
	u := env.Get("ATC_CALL_VOICES")
	if u == "" {
		return Result{Missing, "Not set up: calls have no voice to speak with."}
	}
	code, b, err := fetch(ctx, strings.TrimRight(u, "/")+"/api/voices")
	if err != nil {
		return down(u, err)
	}
	var langs map[string]struct {
		Voices []string `json:"voices"`
	}
	if code != 200 || json.Unmarshal(b, &langs) != nil {
		return Result{Broken, fmt.Sprintf("%s answers, but with no voice list (%d).", site(u), code)}
	}
	n := 0
	for _, l := range langs {
		n += len(l.Voices)
	}
	if n == 0 {
		return Result{Broken, "It answers, but offers no voices."}
	}
	return Result{OK, fmt.Sprintf("%d voices in %d languages.", n, len(langs))}
}

func checkPush(ctx context.Context, env Env) Result {
	if len(env.Devices) == 0 {
		return Result{Missing, "No phone is registered, so nothing pushes."}
	}
	hosts := map[string]bool{}
	for _, d := range env.Devices {
		hosts[site(d)] = true
	}
	var bad []string
	for h := range hosts {
		if _, _, err := fetch(ctx, h); err != nil {
			bad = append(bad, fmt.Sprintf("%s: %s", h, inWords(err)))
		}
	}
	if len(bad) > 0 {
		slices.Sort(bad)
		return Result{Broken, fmt.Sprintf("%d registered, but its push service is down (%s).", len(env.Devices), strings.Join(bad, "; "))}
	}
	return Result{OK, fmt.Sprintf("%d registered, and the push service answers.", len(env.Devices))}
}

func expandHome(p string) string {
	if rest, ok := strings.CutPrefix(p, "~/"); ok {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, rest)
	}
	return p
}

func checkApp(_ context.Context, env Env) Result {
	dir := env.Get("ATC_APP_DIR")
	if dir == "" {
		return Result{Missing, "Not set up: atc offers no app to install or update from."}
	}
	b, err := os.ReadFile(filepath.Join(expandHome(dir), "version.json"))
	if err != nil {
		return Result{Broken, "Set, but no app has been published to that folder."}
	}
	var v struct {
		VersionName string `json:"versionName"`
	}
	if json.Unmarshal(b, &v) != nil || v.VersionName == "" {
		return Result{Broken, "Its version.json can't be read."}
	}
	return Result{OK, "Version " + v.VersionName + " is ready to install."}
}

func checkPeers(ctx context.Context, env Env) Result {
	if len(env.Peers) == 0 {
		return Result{Missing, "Only this machine is listed."}
	}
	type answer struct {
		name string
		err  error
	}
	got := make(chan answer, len(env.Peers))
	for _, p := range env.Peers {
		go func() {
			code, _, err := fetch(ctx, strings.TrimRight(p.URL, "/")+"/api/me", "Authorization", "Bearer "+p.Token)
			if err == nil && code != 200 {
				err = fmt.Errorf("status %d", code)
			}
			got <- answer{p.Name, err}
		}()
	}
	var ok, bad []string
	for range env.Peers {
		a := <-got
		switch {
		case a.err == nil:
			ok = append(ok, a.name)
		case strings.HasPrefix(a.err.Error(), "status "):
			bad = append(bad, a.name+": its token was refused or it answers with an error")
		default:
			bad = append(bad, a.name+": "+inWords(a.err))
		}
	}
	slices.Sort(ok)
	slices.Sort(bad)
	if len(bad) > 0 {
		return Result{Broken, strings.Join(bad, "; ") + "."}
	}
	return Result{OK, strings.Join(ok, ", ") + " answering."}
}

func checkBrowser(ctx context.Context, env Env) Result {
	u := env.Get("ATC_BROWSER")
	if u == "" {
		return Result{Missing, "Not set up: sessions use their own browser tools, if any."}
	}
	code, b, err := fetch(ctx, strings.TrimRight(u, "/")+"/json/version")
	if err != nil {
		return down(u, err)
	}
	var v struct {
		Browser string `json:"Browser"`
	}
	if code != 200 || json.Unmarshal(b, &v) != nil {
		return Result{Broken, fmt.Sprintf("%s answers, but not as Chrome's debug port (%d).", site(u), code)}
	}
	return Result{OK, v.Browser + " is up."}
}

func checkEngines(ctx context.Context, env Env) Result {
	if len(env.Engines) == 0 {
		return Result{Missing, "Only Claude's own models."}
	}
	var names, bad []string
	for _, e := range env.Engines {
		names = append(names, e.Name)
		if e.URL != "" {
			if _, _, err := fetch(ctx, e.URL); err != nil {
				bad = append(bad, e.Name+": "+inWords(err))
			}
		}
	}
	if len(bad) > 0 {
		return Result{Broken, strings.Join(bad, "; ") + "."}
	}
	return Result{OK, strings.Join(names, ", ") + "."}
}

func checkOpenCode(ctx context.Context, env Env) Result {
	u := env.Get("ATC_OPENCODE")
	if u == "" {
		return Result{Missing, "Not set up: sessions run in Claude Code only."}
	}
	code, _, err := fetch(ctx, strings.TrimRight(u, "/")+"/global/health")
	if err != nil {
		return down(u, err)
	}
	if code != 200 {
		return Result{Broken, fmt.Sprintf("%s answers, but not as opencode (%d).", site(u), code)}
	}
	return Result{OK, site(u) + " answers."}
}

func checkSummary(ctx context.Context, env Env) Result {
	if env.Get("ATC_SUMMARY") == "off" {
		return Result{Missing, "Turned off."}
	}
	if env.Get("ATC_SUMMARY_URL") != "" {
		r := urlCheck("ATC_SUMMARY_URL", "")(ctx, env)
		if r.Status == OK {
			r.Detail = "On, with your own model at " + r.Detail
		}
		return r
	}
	model := env.Get("ATC_SUMMARY_MODEL")
	if model == "" {
		model = "haiku"
	}
	return Result{OK, "On, through Claude Code with " + model + ": this spends plan tokens on every finished turn."}
}

func checkWhatsApp(ctx context.Context, env Env) Result {
	keys := []string{"ATC_WHATSAPP_URL", "ATC_WHATSAPP_KEY", "ATC_WHATSAPP_SESSION", "ATC_WHATSAPP_OWNER", "ATC_WHATSAPP_SECRET"}
	var unset []string
	for _, k := range keys {
		if env.Get(k) == "" {
			unset = append(unset, k)
		}
	}
	if len(unset) == len(keys) {
		return Result{Missing, "Not set up."}
	}
	if len(unset) > 0 {
		return Result{Broken, "Partly set up, and atc ignores it until all are there; missing " + strings.Join(unset, ", ") + "."}
	}
	if len(env.Get("ATC_WHATSAPP_SECRET")) < 16 {
		return Result{Broken, "ATC_WHATSAPP_SECRET is shorter than 16 characters, and atc ignores the whole setup until it is not."}
	}
	u := strings.TrimRight(env.Get("ATC_WHATSAPP_URL"), "/")
	code, b, err := fetch(ctx, u+"/api/sessions/"+url.PathEscape(env.Get("ATC_WHATSAPP_SESSION")), "x-api-key", env.Get("ATC_WHATSAPP_KEY"))
	if err != nil {
		return down(u, err)
	}
	switch {
	case code == 401 || code == 403:
		return Result{Broken, "The gateway refuses the API key."}
	case code == 404:
		return Result{Broken, "The gateway has no session with that id."}
	case code != 200:
		return Result{Broken, fmt.Sprintf("The gateway answers with %d.", code)}
	}
	var st struct {
		Status string `json:"status"`
	}
	json.Unmarshal(b, &st)
	if st.Status != "" && st.Status != "ready" {
		return Result{Broken, "The gateway's WhatsApp session is " + st.Status + ", not linked and ready."}
	}
	return Result{OK, "The gateway's session is ready."}
}
