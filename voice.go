package main

import (
	"bytes"
	"cmp"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/settings"
)

//go:embed voice
var voiceFiles embed.FS

const voiceHelp = `atc voice: calls with the assistant, on this machine. Add-on: the app calls it over atc, no phone needed.

  atc voice install [--lang en] [--also tr] [--engine pocket-en] [--voice alba]
                    [--assistant NAME] [--user NAME] [--phone]
  atc voice status
  atc voice uninstall [--purge] [--force]

install writes the call stack to ~/.local/share/atc/voice, downloads its models (~/.cache/atc/voice) and voice
engine, and starts the services. Runs again safely; a restart waits for any call to end. Flags are kept in
~/.config/atc/voice.env, with every other setting (voice/README.md lists them).

  --lang, --also   the call's first language, and others it can switch to (voice/lang/)
  --engine         pocket-en (default, CPU), pocket (Turkish, CPU), piper or kokoro (CPU); higgs needs a GPU and setup by hand
  --voice          the engine's voice; empty is its default
  --phone          also run the phone-on-USB line (voice/device/), otherwise only the app line
uninstall stops and removes the services and the stack's files; --purge also removes models, the venv, recordings and
voice.env; --force does it during a call.
`

func voiceCmd(args []string) error {
	if len(args) == 0 {
		fmt.Print(voiceHelp)
		return nil
	}
	switch args[0] {
	case "install":
		return voiceInstall(args[1:])
	case "status":
		return voiceStatus()
	case "uninstall":
		return voiceUninstall(args[1:])
	}
	fmt.Print(voiceHelp)
	return nil
}

func voiceEnvPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config/atc/voice.env")
}

var envLine = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_]*)=(.*)$`)

func readEnvFile(path string) map[string]string {
	out := map[string]string{}
	b, _ := os.ReadFile(path)
	for _, l := range strings.Split(string(b), "\n") {
		if m := envLine.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
			out[m[1]] = strings.Trim(m[2], `"'`)
		}
	}
	return out
}

// setEnvFile changes or appends keys, leaving other lines and comments as they are; reports whether anything changed.
func setEnvFile(path string, set map[string]string) (bool, error) {
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	var lines []string
	if len(b) > 0 {
		lines = strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	}
	left := map[string]string{}
	for k, v := range set {
		left[k] = v
	}
	for i, l := range lines {
		if m := envLine.FindStringSubmatch(strings.TrimSpace(l)); m != nil {
			if v, ok := left[m[1]]; ok {
				lines[i] = envQuote(m[1], v)
				delete(left, m[1])
			}
		}
	}
	keys := make([]string, 0, len(left))
	for k := range left {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		lines = append(lines, envQuote(k, left[k]))
	}
	now := []byte(strings.Join(lines, "\n") + "\n")
	if bytes.Equal(now, b) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	return true, os.WriteFile(path, now, 0o644)
}

func envQuote(k, v string) string {
	if strings.ContainsAny(v, " \t") {
		return k + `="` + v + `"`
	}
	return k + "=" + v
}

// writeVoiceFiles puts the embedded stack in dir, touching only what differs; reports whether anything did.
func writeVoiceFiles(dir string) (bool, error) {
	changed := false
	err := fs.WalkDir(voiceFiles, "voice", func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == "voice/test" && d.IsDir() {
			if err == nil {
				return fs.SkipDir
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		b, _ := voiceFiles.ReadFile(p)
		rel, _ := filepath.Rel("voice", p)
		dst := filepath.Join(dir, rel)
		if had, err := os.ReadFile(dst); err == nil && bytes.Equal(had, b) {
			return nil
		}
		changed = true
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		mode := fs.FileMode(0o644)
		if strings.HasSuffix(p, ".py") || strings.HasSuffix(p, ".sh") {
			mode = 0o755
		}
		return os.WriteFile(dst, b, mode)
	})
	return changed, err
}

// installLanguage is the user's language when there is a pack for it, so a first install can start calls in it.
func installLanguage() string {
	l := strings.ToLower(strings.TrimSpace(os.Getenv(settings.LanguageKey)))
	if _, err := voiceFiles.ReadFile("voice/lang/" + l + ".json"); l == "" || err != nil {
		return "en"
	}
	return l
}

func voiceDir(env map[string]string) string {
	home, _ := os.UserHomeDir()
	return cmp.Or(env["ATC_VOICE_DIR"], filepath.Join(home, ".local/share/atc/voice"))
}

func voicePort(env map[string]string) string { return cmp.Or(env["DELTA_CALL_PORT"], "8807") }

func voiceUnits(env map[string]string) []string {
	return strings.Fields(cmp.Or(env["ATC_VOICE_UNITS"], "delta-call delta-tts delta-talk-app"))
}

func voiceInstall(args []string) error {
	fs := flag.NewFlagSet("voice install", flag.ExitOnError)
	fs.Usage = func() { fmt.Print(voiceHelp) }
	lang := fs.String("lang", "", "")
	also := fs.String("also", "", "")
	engine := fs.String("engine", "", "")
	voice := fs.String("voice", "", "")
	assistant := fs.String("assistant", "", "")
	user := fs.String("user", "", "")
	phone := fs.Bool("phone", false, "")
	fs.Parse(args)
	if runtime.GOOS != "linux" {
		return fmt.Errorf("atc voice install is Linux only for now (it installs systemd user units); on %s nothing was changed", runtime.GOOS)
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("atc voice install needs systemd (no systemctl here)")
	}
	if _, err := exec.LookPath("uv"); err != nil {
		return errors.New("uv is missing, and the call stack runs on it. Install it with:\n  curl -LsSf https://astral.sh/uv/install.sh | sh\nthen run atc voice install again")
	}
	path := voiceEnvPath()
	env := readEnvFile(path)
	set := map[string]string{}
	first := func(key, flagValue, fallback string) {
		if v := cmp.Or(flagValue, env[key], fallback); v != "" && v != env[key] {
			set[key] = v
		}
	}
	first("TALK_LANG", *lang, installLanguage())
	first("TALK_ALSO", *also, "")
	first("TALK_ASSISTANT", *assistant, "")
	first("TALK_USER", *user, "")
	first("TTS_ENGINES", *engine, "pocket-en")
	first("TALK_TTS_ENGINE", strings.Split(*engine, ",")[0], "pocket-en")
	first("TALK_TTS_VOICE", *voice, "")
	if *phone {
		set["DELTA_CALL_BRIDGE"] = "1"
		set["ATC_VOICE_UNITS"] = "delta-call delta-tts delta-talk delta-talk-app"
	}
	envChanged, err := setEnvFile(path, set)
	if err != nil {
		return err
	}
	env = readEnvFile(path)
	dir := voiceDir(env)
	filesChanged, err := writeVoiceFiles(dir)
	if err != nil {
		return err
	}
	if !envChanged && !filesChanged && voiceAllActive(env) {
		fmt.Println("Nothing changed and every service is up; checking the models.")
		if err := voiceRun(dir, "uv", "run", "-q", "--script", filepath.Join(dir, "fetch.py")); err != nil {
			return err
		}
	} else if err := voiceRun(dir, "bash", filepath.Join(dir, "deploy.sh")); err != nil {
		return err
	}
	line := "http://127.0.0.1:" + voicePort(env)
	atcEnv := filepath.Join(client.ConfigDir(), "env")
	if readEnvFile(atcEnv)["ATC_CALL_LINE"] == "" {
		if _, err := setEnvFile(atcEnv, map[string]string{"ATC_CALL_LINE": line}); err != nil {
			return err
		}
		exec.Command("systemctl", "--user", "try-restart", "atc", "atc-hub").Run()
		fmt.Println("Set ATC_CALL_LINE in", atcEnv)
	}
	fmt.Println("Installed. Call the assistant from the atc app. atc voice status shows how it stands.")
	return nil
}

func voiceRun(dir, name string, args ...string) error {
	c := exec.Command(name, args...)
	c.Dir, c.Stdout, c.Stderr = dir, os.Stdout, os.Stderr
	return c.Run()
}

func voiceAllActive(env map[string]string) bool {
	for _, u := range voiceUnits(env) {
		if exec.Command("systemctl", "--user", "is-active", "-q", u+".service").Run() != nil {
			return false
		}
	}
	return true
}

func getJSON(url string) (map[string]any, error) {
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

func voiceStatus() error {
	path := voiceEnvPath()
	if _, err := os.Stat(path); err != nil {
		fmt.Println("Not installed: atc voice install sets it up.")
		return nil
	}
	env := readEnvFile(path)
	fmt.Printf("settings   %s\nfiles      %s\nlanguage   %s %s\nvoice      %s %s\n", path, voiceDir(env), env["TALK_LANG"], env["TALK_ALSO"], env["TALK_TTS_ENGINE"], env["TALK_TTS_VOICE"])
	for _, u := range voiceUnits(env) {
		out, _ := exec.Command("systemctl", "--user", "is-active", u+".service").Output()
		fmt.Printf("%-16s %s\n", u, strings.TrimSpace(string(out)))
	}
	st, err := getJSON("http://127.0.0.1:" + voicePort(env) + "/status")
	if err != nil {
		fmt.Println("call line  not reachable:", err)
	} else {
		fmt.Printf("call line  %v, talkers %v\n", st["call"], st["talkers"])
	}
	if h, err := getJSON(hubURL() + "/status"); err != nil {
		fmt.Println("hub        not reachable, so a call has no one to talk to:", err)
	} else {
		fmt.Printf("hub        alive %v\n", h["alive"])
	}
	return nil
}

func voiceUninstall(args []string) error {
	flags := flag.NewFlagSet("voice uninstall", flag.ExitOnError)
	flags.Usage = func() { fmt.Print(voiceHelp) }
	purge := flags.Bool("purge", false, "")
	force := flags.Bool("force", false, "")
	flags.Parse(args)
	path := voiceEnvPath()
	env := readEnvFile(path)
	if st, err := getJSON("http://127.0.0.1:" + voicePort(env) + "/status"); err == nil && !*force && (st["call"] != "idle" || (st["app"] != nil && st["app"] != "connected")) {
		return errors.New("a call is on; try again when it ends, or use --force")
	}
	home, _ := os.UserHomeDir()
	units := filepath.Join(home, ".config/systemd/user")
	for _, u := range []string{"delta-talk-app", "delta-talk", "delta-tts", "delta-higgs", "delta-call"} {
		if _, err := os.Stat(filepath.Join(units, u+".service")); err == nil {
			exec.Command("systemctl", "--user", "disable", "--now", u+".service").Run()
			os.Remove(filepath.Join(units, u+".service"))
		}
	}
	os.Remove(filepath.Join(units, "calls.slice"))
	exec.Command("systemctl", "--user", "daemon-reload").Run()
	dir := voiceDir(env)
	var dirs []string
	fs.WalkDir(voiceFiles, "voice", func(p string, d fs.DirEntry, err error) error {
		rel, _ := filepath.Rel("voice", p)
		if d.IsDir() {
			dirs = append(dirs, filepath.Join(dir, rel))
		} else {
			os.Remove(filepath.Join(dir, rel))
		}
		return nil
	})
	os.RemoveAll(filepath.Join(dir, "__pycache__"))
	slices.Reverse(dirs)
	for _, d := range dirs {
		os.Remove(d)
	}
	atcEnv := filepath.Join(client.ConfigDir(), "env")
	if readEnvFile(atcEnv)["ATC_CALL_LINE"] == "http://127.0.0.1:"+voicePort(env) {
		if b, err := os.ReadFile(atcEnv); err == nil {
			kept := slices.DeleteFunc(strings.Split(string(b), "\n"), func(l string) bool { return strings.HasPrefix(l, "ATC_CALL_LINE=") })
			os.WriteFile(atcEnv, []byte(strings.Join(kept, "\n")), 0o644)
		}
	}
	if *purge {
		for _, p := range []string{
			cmp.Or(env["TTS_VENV"], filepath.Join(home, ".local/share/atc/voice/tts-venv")),
			cmp.Or(env["TALK_MODELS"], filepath.Join(home, ".cache/atc/voice")),
			cmp.Or(env["TALK_STATE"], filepath.Join(home, ".local/state/atc/voice")),
			dir,
		} {
			os.RemoveAll(p)
		}
		os.Remove(path)
	}
	fmt.Println("Removed.")
	return nil
}
