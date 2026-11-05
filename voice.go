package main

import (
	"bytes"
	"cmp"
	"embed"
	"encoding/json"
	"encoding/xml"
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
	"github.com/zcag/atc/internal/server"
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
  --engine         by default the one for each language: pocket-en (CPU) for English, pocket (CPU) for Turkish. Also
                   piper or kokoro (English, CPU); higgs needs a GPU and setup by hand.
                   An Intel Mac has no torch for pocket and pocket-en, so piper is its default (docs/calls.md, On a Mac)
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
	case "unit":
		return voiceUnitCmd(args[1:])
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

// voiceHostError says why calls can't be installed here, before anything changes.
func voiceHostError() error {
	if voiceOnMac() {
		return nil
	}
	if runtime.GOOS != "linux" {
		return fmt.Errorf("atc voice install runs on Linux and macOS; on %s nothing was changed", runtime.GOOS)
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("atc voice install needs systemd (no systemctl here)")
	}
	return nil
}

// ensureUV installs uv, which the stack runs on, where the units look for it.
func ensureUV() error {
	home, _ := os.UserHomeDir()
	os.Setenv("PATH", filepath.Join(home, ".local", "bin")+string(os.PathListSeparator)+os.Getenv("PATH"))
	if _, err := exec.LookPath("uv"); err == nil {
		return nil
	}
	fmt.Println("Installing uv, which the call stack runs on, into ~/.local/bin.")
	c := exec.Command("sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | UV_NO_MODIFY_PATH=1 sh")
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("uv could not be installed (%w). Install it with:\n  curl -LsSf https://astral.sh/uv/install.sh | sh\nthen run atc voice install again", err)
	}
	return nil
}

// speaks says whether an engine can read a language: higgs and a remote server read whatever they are given.
func speaks(engine, lang string) bool {
	switch engine {
	case "higgs", "remote":
		return true
	case "pocket":
		return lang == "tr"
	}
	return lang == "en"
}

func engineForLang(engines []string, lang string) string {
	if i := slices.IndexFunc(engines, func(e string) bool { return speaks(e, lang) }); i >= 0 {
		return engines[i]
	}
	return ""
}

// wantedEngines keeps what is installed and adds the default engine of each language nothing there can speak.
func wantedEngines(have string, langs []string, goos, goarch string) string {
	engines := strings.FieldsFunc(have, func(r rune) bool { return r == ',' })
	for _, l := range langs {
		if engineForLang(engines, l) == "" {
			engines = append(engines, defaultEngine(l, goos, goarch))
		}
	}
	return strings.Join(engines, ",")
}

// voiceEngineKeys is what voice.env needs for each language's engine: TALK_TTS_ENGINE for the first language,
// TALK_TTS_ENGINE_<CODE> for the others, leaving alone what can already speak it.
func voiceEngineKeys(env map[string]string, engines string, langs []string) map[string]string {
	list, set := strings.Split(engines, ","), map[string]string{}
	for i, l := range langs {
		key := "TALK_TTS_ENGINE"
		if i > 0 {
			key += "_" + strings.ToUpper(l)
		}
		if have := env[key]; slices.Contains(list, have) && speaks(have, l) {
			continue
		}
		set[key] = engineForLang(list, l)
	}
	return set
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
	if err := voiceHostError(); err != nil {
		return err
	}
	if *phone {
		if _, err := exec.LookPath("adb"); err != nil {
			return errors.New("--phone drives the phone with adb, which is missing. Install Android's platform-tools, then run atc voice install --phone again")
		}
	}
	path := voiceEnvPath()
	env := readEnvFile(path)
	langs := append([]string{cmp.Or(*lang, env["TALK_LANG"], installLanguage())}, strings.Fields(cmp.Or(*also, env["TALK_ALSO"]))...)
	engines := cmp.Or(*engine, wantedEngines(env["TTS_ENGINES"], langs, runtime.GOOS, runtime.GOARCH))
	if err := engineRuns(engines, runtime.GOOS, runtime.GOARCH); err != nil {
		return err
	}
	for _, l := range langs {
		if engineForLang(strings.Split(engines, ","), l) == "" {
			return fmt.Errorf("none of %s can speak %s. Nothing was changed. Leave out --engine for the default, or add one that can", engines, l)
		}
	}
	if err := ensureUV(); err != nil {
		return err
	}
	if voiceOnMac() && slices.Contains(strings.Split(engines, ","), "higgs") {
		fmt.Println("Note: higgs has only been run on Linux. On a Mac it needs audio.cpp's server built and started by you on :8841 (HIGGS_URL); until it answers, the voice engine keeps restarting.")
	}
	set := map[string]string{}
	first := func(key, flagValue, fallback string) {
		if v := cmp.Or(flagValue, env[key], fallback); v != "" && v != env[key] {
			set[key] = v
		}
	}
	first("TALK_LANG", langs[0], "")
	first("TALK_ALSO", *also, "")
	first("TALK_ASSISTANT", *assistant, "")
	first("TALK_USER", *user, "")
	first("TTS_ENGINES", engines, "")
	for k, v := range voiceEngineKeys(env, engines, langs) {
		set[k] = v
	}
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
	if err := keepAssistantVoices(env, langs); err != nil {
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
	if err := setUnset(map[string]string{"ATC_CALL_LINE": voiceLine(env), "ATC_CALL_VOICES": voicePicker(env)}, "atc", "hub"); err != nil {
		return err
	}
	if err := ensureCharacters(); err != nil {
		fmt.Println("The characters could not be downloaded, so calls show the orb until you run atc app characters:", err)
	}
	fmt.Println("Installed. Call the assistant from the atc app. atc voice status shows how it stands.")
	return nil
}

func voiceLine(env map[string]string) string { return "http://127.0.0.1:" + voicePort(env) }

func voicePicker(env map[string]string) string {
	return "http://127.0.0.1:" + cmp.Or(env["TTS_PORT"], "8812")
}

// setUnset writes to atc's env file the settings that have no value yet, by file or by Settings, and restarts what reads them.
func setUnset(want map[string]string, restart ...string) error {
	path := filepath.Join(client.ConfigDir(), "env")
	had := readEnvFile(path)
	for k := range want {
		if had[k] != "" || os.Getenv(k) != "" {
			delete(want, k)
		}
	}
	if len(want) == 0 {
		return nil
	}
	if _, err := setEnvFile(path, want); err != nil {
		return err
	}
	restartServices(restart...)
	for k, v := range want {
		fmt.Printf("Set %s=%s in %s\n", k, v, path)
	}
	return nil
}

// keepAssistantVoices starts a language off with the voice of the person who is the assistant in it, unless voice.env names
// one or a pick has been made.
func keepAssistantVoices(env map[string]string, langs []string) error {
	var d server.Persons
	saved, err := os.ReadFile(filepath.Join(client.ConfigDir(), "persons.json"))
	if err != nil {
		saved, _ = voiceFiles.ReadFile("voice/persons.json")
	}
	if json.Unmarshal(saved, &d) != nil {
		return nil
	}
	home, _ := os.UserHomeDir()
	path := filepath.Join(cmp.Or(env["TALK_STATE"], filepath.Join(home, ".local/state/atc/voice")), "voice.json")
	picks := map[string]string{}
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &picks)
	}
	changed := false
	for i, l := range langs {
		named := env["TALK_TTS_VOICE_"+strings.ToUpper(l)]
		if i == 0 {
			named = cmp.Or(named, env["TALK_TTS_VOICE"])
		}
		for _, p := range d.Persons {
			if p.ID == d.Langs[l] && p.Voices[l] != "" && picks[l] == "" && named == "" {
				picks[l], changed = p.Voices[l], true
			}
		}
	}
	if !changed {
		return nil
	}
	b, _ := json.Marshal(picks)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func voiceRun(dir, name string, args ...string) error {
	c := exec.Command(name, args...)
	c.Dir, c.Stdout, c.Stderr = dir, os.Stdout, os.Stderr
	if exe, err := os.Executable(); err == nil {
		c.Env = append(os.Environ(), "ATC_BIN="+exe)
	}
	return c.Run()
}

func voiceOnMac() bool { return runtime.GOOS == "darwin" }

// defaultEngine is pocket for Turkish, and for English pocket-en wherever torch ships for the machine, and piper on an Intel
// Mac, where it does not.
func defaultEngine(lang, goos, goarch string) string {
	if lang == "tr" {
		return "pocket"
	}
	if goos == "darwin" && goarch == "amd64" {
		return "piper"
	}
	return "pocket-en"
}

func engineRuns(engines, goos, goarch string) error {
	for _, e := range strings.Split(engines, ",") {
		if goos == "darwin" && goarch == "amd64" && (e == "pocket" || e == "pocket-en") {
			return fmt.Errorf("the %s voice can't run on an Intel Mac: it needs torch 2.5 or newer, which has no Intel Mac build. Nothing was changed. Use --engine piper or --engine kokoro, or install on an Apple Silicon Mac or Linux", e)
		}
	}
	return nil
}

// restartServices has running services read what was just written to their env file, by service name. Only jobs of this
// home: launchd's labels are per user, not per home, so a scratch HOME would otherwise restart the real atc.
func restartServices(names ...string) {
	for _, n := range names {
		for _, s := range services(n) {
			if !voiceOnMac() {
				exec.Command("systemctl", "--user", "try-restart", s.unit).Run()
			} else if _, err := os.Stat(macPlist(s)); err == nil {
				exec.Command("launchctl", "kickstart", "-k", macDomain()+"/"+macName(s)).Run()
			}
		}
	}
}

func voiceUnitState(u string) string {
	if voiceOnMac() {
		return macState(service{name: u, bin: u, unit: u})
	}
	out, _ := exec.Command("systemctl", "--user", "is-active", u+".service").Output()
	return strings.TrimSpace(string(out))
}

func voiceAllActive(env map[string]string) bool {
	for _, u := range voiceUnits(env) {
		if s := voiceUnitState(u); s != "active" && s != "running" {
			return false
		}
	}
	return true
}

// voiceUnitCmd is deploy.sh's way to launchd, so that its plists come from one place.
func voiceUnitCmd(args []string) error {
	if len(args) != 2 || !voiceOnMac() {
		return errors.New("usage, on macOS: atc voice unit start|active <unit>")
	}
	u := service{name: args[1], bin: args[1], unit: args[1]}
	switch args[0] {
	case "active":
		if macState(u) != "running" {
			os.Exit(1)
		}
		return nil
	case "start":
		home, _ := os.UserHomeDir()
		unit, err := os.ReadFile(filepath.Join(voiceDir(readEnvFile(voiceEnvPath())), "systemd", args[1]+".service"))
		if err != nil {
			return err
		}
		tpl, err := units.ReadFile("deploy/atc.plist")
		if err != nil {
			return err
		}
		return macLoad(u, voicePlist(tpl, u, unitCommand(string(unit), home)))
	}
	return fmt.Errorf("atc voice unit: no %s", args[0])
}

var (
	plistCommand = regexp.MustCompile(`<string>set -a;.*</string>`)
	unitBraced   = regexp.MustCompile(`\$\{(\w+)\}`)
)

// unitCommand is a systemd unit as one sh command, so the units stay the only definition of how each service runs: what
// systemd does with its Environment=, EnvironmentFile= and ExecStart= lines, in the same order. ${X} is one word to
// systemd and $X is split, and %h and HOME are spelled out, since launchd gives a job the login's real home.
func unitCommand(unit, home string) string {
	out := []string{"set -a", "HOME=" + shellQuote(home), "PYTHONUNBUFFERED=1", "UV_PYTHON=3.12"}
	var start string
	for _, l := range strings.Split(strings.ReplaceAll(unit, "%h", home), "\n") {
		key, v, _ := strings.Cut(l, "=")
		switch key {
		case "Environment":
			k, val, _ := strings.Cut(v, "=")
			if k != "PATH" {
				out = append(out, k+"="+shellQuote(val))
			}
		case "EnvironmentFile":
			f := shellQuote(strings.TrimPrefix(v, "-"))
			out = append(out, "[ -f "+f+" ] && . "+f)
		case "ExecStart":
			start = strings.ReplaceAll(unitBraced.ReplaceAllString(v, `"$${$1}"`), "$$", "$")
		}
	}
	path := home + "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	return strings.Join(append(out, "PATH="+shellQuote(path), "set +a", "exec "+start), "; ")
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// voicePlist is atc's plist with a voice unit's command, with stdout in the log too, its children stopped with it (atc
// keeps its sessions, a talker has none to keep), and first in line for the CPU, as calls.slice is on Linux.
func voicePlist(tpl []byte, s service, command string) []byte {
	var esc bytes.Buffer
	xml.EscapeText(&esc, []byte(command))
	b := macRelabel(tpl, s)
	b = plistCommand.ReplaceAllLiteral(b, []byte("<string>"+esc.String()+"</string>"))
	b = bytes.ReplaceAll(b, []byte("<key>AbandonProcessGroup</key>\n\t<true/>"), []byte("<key>ProcessType</key>\n\t<string>Interactive</string>"))
	return bytes.ReplaceAll(b, []byte("<key>StandardErrorPath</key>"), []byte("<key>StandardOutPath</key>\n\t<string>/tmp/"+s.bin+".log</string>\n\t<key>StandardErrorPath</key>"))
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
		fmt.Printf("%-16s %s\n", u, voiceUnitState(u))
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

func removeVoiceUnits(home string) {
	names := []string{"delta-talk-app", "delta-talk", "delta-tts", "delta-higgs", "delta-call"}
	if voiceOnMac() {
		for _, u := range names {
			s := service{name: u, bin: u, unit: u}
			if _, err := os.Stat(macPlist(s)); err == nil {
				macUnload(s)
				os.Remove(macPlist(s))
				os.Remove("/tmp/" + u + ".log")
			}
		}
		return
	}
	units := filepath.Join(home, ".config/systemd/user")
	for _, u := range names {
		if _, err := os.Stat(filepath.Join(units, u+".service")); err == nil {
			exec.Command("systemctl", "--user", "disable", "--now", u+".service").Run()
			os.Remove(filepath.Join(units, u+".service"))
		}
	}
	os.Remove(filepath.Join(units, "calls.slice"))
	exec.Command("systemctl", "--user", "daemon-reload").Run()
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
	removeVoiceUnits(home)
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
	ours := map[string]string{"ATC_CALL_LINE": voiceLine(env), "ATC_CALL_VOICES": voicePicker(env)}
	had := readEnvFile(atcEnv)
	if b, err := os.ReadFile(atcEnv); err == nil {
		kept := slices.DeleteFunc(strings.Split(string(b), "\n"), func(l string) bool {
			k, _, _ := strings.Cut(l, "=")
			return ours[k] != "" && had[k] == ours[k]
		})
		os.WriteFile(atcEnv, []byte(strings.Join(kept, "\n")), 0o644)
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
