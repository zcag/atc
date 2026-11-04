package caps

import (
	"cmp"
	"strings"
)

const (
	Core      = "Core"
	Assistant = "Assistant"
	Calls     = "Calls"
	Phone     = "Phone"
	Machines  = "Machines"
	Browser   = "Browser"
	Models    = "Other models"
	Summaries = "Summaries"
	WhatsApp  = "WhatsApp"
)

// Groups is the order they are shown in.
var Groups = []string{Core, Assistant, Calls, Phone, Machines, Browser, Models, Summaries, WhatsApp}

const docs = "https://github.com/zcag/atc/blob/master/docs/"

// A guide is a page in docs/ with an optional anchor: "install#requirements" or "calls". docs_test.go checks each exists.
func GuideURL(guide string) string {
	page, anchor, ok := strings.Cut(guide, "#")
	if !ok {
		return docs + page + ".md"
	}
	return docs + page + ".md#" + anchor
}

// GuideName is a guide's title, from its anchor or its page.
func GuideName(guide string) string {
	page, anchor, _ := strings.Cut(guide, "#")
	s := strings.ReplaceAll(cmp.Or(anchor, page), "-", " ")
	return strings.ToUpper(s[:1]) + s[1:]
}

// MinClaude is the first Claude Code with background sessions and `claude agents` (its changelog, "Added agent view");
// atc is built on them. There is no upper bound.
const MinClaude = "2.1.139"

// All is the registry.
func All() []Cap {
	return []Cap{
		{
			ID: "claude", Title: "Claude Code", Group: Core, Why: "Every session is a Claude Code session.",
			Check: checkClaude,
			Fix: Fix{Command: "curl -fsSL https://claude.ai/install.sh | bash",
				Text:  "Install it, or update with `claude update`, so that `claude` is on the PATH of the user atc runs as. On Windows, run atc inside WSL. If it lives elsewhere, point ATC_CLAUDE_BIN at it in atc's environment.",
				Guide: "install#requirements"},
			Cost: "A Claude plan or an API key.",
		},
		{
			ID: "signin", Title: "Signed in to Claude", Group: Core, Why: "Claude Code can't start a session until it is signed in.",
			Needs: []string{"claude"}, Check: checkSignin,
			Fix: Fix{Command: "claude auth login", Text: "Run it in a terminal on this machine; it opens a browser, or prints a link to open on any device.", Guide: "install#requirements"},
		},
		{
			ID: "server", Title: "atc server", Group: Core, Why: "Serves this page, the sessions and everything else here.",
			Check: checkServer,
			Fix:   Fix{Command: "atc service install", Text: "Run it as a service, or start it by hand with `atc serve`.", Guide: "install#run-it-as-a-service"},
		},
		{
			ID: "reach", Title: "HTTPS address", Group: Core, Optional: true, Why: "The address you reach atc at from other devices. Browsers only give a page the microphone over HTTPS.",
			Fields: []Field{{Key: "ATC_PUBLIC_URL", Label: "Address", Hint: "https://atc.example.com", URL: true}},
			Check:  checkReach,
			Fix:    Fix{Text: "Put atc behind a reverse proxy with a certificate (Caddy, Tailscale Serve), and enter the address it answers at.", Guide: "install#reach-it-from-other-devices"},
		},
		{
			ID: "hub", Title: "Assistant hub", Group: Assistant, Optional: true, Why: "Keeps the assistant one conversation across atc, WhatsApp and calls.",
			Needs: []string{"claude", "signin"}, Fields: []Field{{Key: "ATC_HUB", Label: "Hub address", Hint: "http://127.0.0.1:8820", URL: true}},
			Check: checkHub,
			Fix:   Fix{Command: "atc service install --only hub", Text: "Run the hub as a service on this machine, then enter its address here.", Guide: "assistant"},
			Cost:  "Plan tokens for what you ask it.",
		},
		{
			ID: "calls", Title: "Calls with the assistant", Group: Calls, Optional: true, Why: "Talk to the assistant by voice, from this page or the phone app.",
			Needs: []string{"hub", "call-line", "talker", "voices"},
			Fix:   Fix{Text: "Set up what it still needs, in the rows below.", Guide: "calls"},
			Cost:  "A GPU for speech, or a CPU with slower replies, and plan tokens for the assistant.",
		},
		{
			ID: "call-line", Title: "Call line", Group: Calls, Optional: true, Why: "The service that carries a call's audio between your device and the talker.",
			Fields: []Field{{Key: "ATC_CALL_LINE", Label: "Call line address", Hint: "http://127.0.0.1:8807", URL: true, Hub: true}},
			Check:  checkCallLine,
			Fix:    Fix{Text: "Run the call line service, then enter its address here.", Guide: "calls"},
		},
		{
			ID: "talker", Title: "Talker", Group: Calls, Optional: true, Why: "Holds the call: hears you, knows when you are done, and speaks the assistant's words.",
			Needs: []string{"call-line"}, Check: checkTalker,
			Fix:  Fix{Text: "Run a talker (talk.py) and connect it to the call line.", Guide: "calls"},
			Cost: "A GPU, or a CPU with slower replies, for speech in and out.",
		},
		{
			ID: "voices", Title: "Voices", Group: Calls, Optional: true, Why: "Lists the voices a call can speak with and keeps your pick.",
			Fields: []Field{{Key: "ATC_CALL_VOICES", Label: "Voices address", Hint: "http://127.0.0.1:8806", URL: true}},
			Check:  checkVoices,
			Fix:    Fix{Text: "Run the voice service, then enter its address here.", Guide: "calls"},
			Cost:   "A GPU for the better voices.",
		},
		{
			ID: "push", Title: "Phone notifications", Group: Phone, Optional: true, Why: "A push when a session waits on you or finishes its turn.",
			Check: checkPush,
			Fix:   Fix{Text: "Install the app and a UnifiedPush distributor such as ntfy on the phone, then open the app once so it registers.", Guide: "android"},
		},
		{
			ID: "app", Title: "Android app", Group: Phone, Optional: true, Why: "The folder atc serves the app and its updates from.",
			Fields: []Field{{Key: "ATC_APP_DIR", Label: "App folder", Hint: "~/.local/share/atc/app"}},
			Check:  checkApp,
			Fix:    Fix{Command: "make android && make android-publish", Text: "Build the app and publish it into that folder.", Guide: "android"},
			Cost:   "The Android SDK on the machine that builds it.",
		},
		{
			ID: "peers", Title: "Other machines", Group: Machines, Optional: true, Why: "Lists the sessions of your other machines here too.",
			Check: checkPeers,
			Fix:   Fix{Text: "List them in peers.json in atc's config folder, each with its name, url and token (`atc token` on that machine).", Guide: "machines"},
		},
		{
			ID: "browser", Title: "Shared browser", Group: Browser, Optional: true, Why: "Gives sessions their own tabs in a browser, which you see and can click in here.",
			Fields: []Field{{Key: "ATC_BROWSER", Label: "Chrome debug address", Hint: "http://127.0.0.1:9222", URL: true}},
			Check:  checkBrowser,
			Fix:    Fix{Text: "Run a Chrome with --remote-debugging-port=9222 and a profile of its own, then enter its address here.", Guide: "browser"},
			Cost:   "The memory an always-on browser takes.",
		},
		{
			ID: "engines", Title: "Engines", Group: Models, Optional: true, Why: "Other models that new sessions can run on.",
			Check: checkEngines,
			Fix:   Fix{Text: "List them in engines.json in atc's config folder.", Guide: "models#other-models"},
			Cost:  "A paid key or your own GPU, depending on the model.",
		},
		{
			ID: "opencode", Title: "opencode", Group: Models, Optional: true, Why: "Runs and shows opencode sessions next to Claude's.",
			Fields: []Field{{Key: "ATC_OPENCODE", Label: "opencode server address", Hint: "http://127.0.0.1:4096", URL: true}},
			Check:  checkOpenCode,
			Fix:    Fix{Command: "make install-opencode", Text: "Run the opencode server as a service, then enter its address here.", Guide: "models#opencode"},
			Cost:   "A paid key or your own GPU, depending on the model.",
		},
		{
			ID: "summary", Title: "Summaries", Group: Summaries, Optional: true, Why: "A finished turn's final message, in short, on its row.",
			Needs: []string{"claude"},
			Fields: []Field{{Key: "ATC_SUMMARY", Label: "off turns them off", Hint: "off"},
				{Key: "ATC_SUMMARY_URL", Label: "Your own model (OpenAI-compatible)", Hint: "http://127.0.0.1:11434/v1/chat/completions", URL: true},
				{Key: "ATC_SUMMARY_MODEL", Label: "Model", Hint: "haiku"}},
			Check: checkSummary,
			Fix:   Fix{Text: "On by default. Point them at your own model to spend no plan tokens, or turn them off.", Guide: "summaries#what-it-costs-and-how-to-change-it"},
			Cost:  "Plan tokens for every finished turn (haiku), unless they run on your own model.",
		},
		{
			ID: "whatsapp", Title: "WhatsApp", Group: WhatsApp, Optional: true, Why: "Talk to the assistant on WhatsApp, through an OpenWA gateway on a number of its own.",
			Needs: []string{"hub"},
			Fields: []Field{{Key: "ATC_WHATSAPP_URL", Label: "Gateway address", Hint: "http://127.0.0.1:2785", URL: true},
				{Key: "ATC_WHATSAPP_KEY", Label: "API key", Secret: true},
				{Key: "ATC_WHATSAPP_SESSION", Label: "Session id"},
				{Key: "ATC_WHATSAPP_OWNER", Label: "Your number", Hint: "12025550100", Hub: true},
				{Key: "ATC_WHATSAPP_SECRET", Label: "Webhook secret, 16 characters or more", Secret: true},
				{Key: "ATC_WHATSAPP_HOOK", Label: "Webhook address atc is reached at", URL: true}},
			Check: checkWhatsApp,
			Fix:   Fix{Text: "Run an OpenWA gateway, link a WhatsApp account to it, and fill these in.", Guide: "whatsapp#whatsapp"},
			Cost:  "A second phone number, and plan tokens for the assistant.",
		},
		{
			ID: "stt", Title: "Voice notes: hearing", Group: WhatsApp, Optional: true, Why: "Turns the voice notes you send into text. Only WhatsApp voice notes use this.",
			Needs: []string{"whatsapp"},
			Fields: []Field{{Key: "ATC_STT_URL", Label: "Speech to text (OpenAI-compatible)", Hint: "http://127.0.0.1:8000/v1/audio/transcriptions", URL: true},
				{Key: "ATC_STT_MODEL", Label: "Model", Hint: "whisper-1"}},
			Check: urlCheck("ATC_STT_URL", "Voice notes are not transcribed."),
			Fix:   Fix{Text: "Point it at a Whisper server or a paid speech API.", Guide: "whatsapp#speech-services"},
			Cost:  "A GPU or a paid key.",
		},
		{
			ID: "tts", Title: "Voice notes: speaking", Group: WhatsApp, Optional: true, Why: "Answers a voice note with one. Only WhatsApp voice notes use this.",
			Needs: []string{"whatsapp"},
			Fields: []Field{{Key: "ATC_TTS_URL", Label: "Text to speech (OpenAI-compatible)", Hint: "http://127.0.0.1:8000/v1/audio/speech", URL: true},
				{Key: "ATC_TTS_MODEL", Label: "Model", Hint: "tts-1"},
				{Key: "ATC_TTS_VOICE", Label: "Voice", Hint: "alloy"}},
			Check: urlCheck("ATC_TTS_URL", "Voice notes get a written answer."),
			Fix:   Fix{Text: "Point it at a speech server or a paid speech API. ATC_TTS_<LANG>_URL adds one for a language this one can't speak.", Guide: "whatsapp#speech-services"},
			Cost:  "A GPU or a paid key.",
		},
		{
			ID: "speech-llm", Title: "Voice notes: shortening", Group: WhatsApp, Optional: true, Why: "Condenses a long reply into what would be said out loud. Only WhatsApp voice notes use this.",
			Needs: []string{"tts"},
			Fields: []Field{{Key: "ATC_SPEECH_LLM_URL", Label: "Model address (OpenAI-compatible)", Hint: "http://127.0.0.1:11434/v1/chat/completions", URL: true},
				{Key: "ATC_SPEECH_LLM_MODEL", Label: "Model"}},
			Check: urlCheck("ATC_SPEECH_LLM_URL", "Voice notes read the reply as written."),
			Fix:   Fix{Text: "Point it at a small local model.", Guide: "whatsapp#speech-services"},
			Cost:  "A GPU or a paid key.",
		},
	}
}

func byID(id string) Cap {
	for _, c := range All() {
		if c.ID == id {
			return c
		}
	}
	return Cap{}
}
