package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/zcag/atc/internal/llm"
)

type Voice struct {
	STT, STTModel, STTPrompt, STTLanguage string
	STTLanguages                          []string
	TTS, TTSModel, TTSVoice               string
	Speakers                              map[string]Speaker
	LLM, LLMModel                         string
}

// Speaker is a text-to-speech engine for one language, for one the default voice can't speak.
type Speaker struct{ URL, Model, Voice string }

var speakerEnv = regexp.MustCompile(`^ATC_TTS_([A-Z]{2})_URL$`)

// speakers reads ATC_TTS_<LANG>_URL (and _MODEL, _VOICE) for each language that has one.
func speakers() map[string]Speaker {
	out := map[string]Speaker{}
	for _, kv := range os.Environ() {
		name, url, _ := strings.Cut(kv, "=")
		if m := speakerEnv.FindStringSubmatch(name); m != nil && url != "" {
			out[strings.ToLower(m[1])] = Speaker{url, os.Getenv("ATC_TTS_" + m[1] + "_MODEL"), os.Getenv("ATC_TTS_" + m[1] + "_VOICE")}
		}
	}
	return out
}

func VoiceFromEnv() Voice {
	return Voice{
		STT: os.Getenv("ATC_STT_URL"), STTModel: cmp.Or(os.Getenv("ATC_STT_MODEL"), "whisper-1"), STTPrompt: os.Getenv("ATC_STT_PROMPT"), STTLanguage: os.Getenv("ATC_STT_LANGUAGE"),
		STTLanguages: strings.FieldsFunc(os.Getenv("ATC_STT_LANGUAGES"), func(r rune) bool { return r == ',' || r == ' ' }),
		TTS:          os.Getenv("ATC_TTS_URL"), TTSModel: cmp.Or(os.Getenv("ATC_TTS_MODEL"), "tts-1"), TTSVoice: cmp.Or(os.Getenv("ATC_TTS_VOICE"), "alloy"),
		Speakers: speakers(),
		LLM:      os.Getenv("ATC_SPEECH_LLM_URL"), LLMModel: os.Getenv("ATC_SPEECH_LLM_MODEL"),
	}
}

const condensePrompt = `You turn a coding assistant's reply into what it would say out loud to the person who asked. ` +
	`One to three short spoken sentences, in the reply's own language. Keep the outcome, any question it asks, and anything the person must decide. ` +
	`No code, no markdown, no file paths unless essential, no lists. Do not add anything that is not in the reply.`

var voiceClient = &http.Client{Timeout: 90 * time.Second}

// transcribe turns speech into text. With ATC_STT_LANGUAGES set, Whisper detects the language
// but only those count: a clip heard as anything else (short English as Icelandic, Turkish too)
// is transcribed in each of them, and the first that writes letters plain English has none
// (ç, ğ, ı) wins, else the first listed. Pinned to Turkish, English speech still comes out as
// English, so that tells them apart. Without it, ATC_STT_LANGUAGE pins every clip.
func (s *Server) transcribe(ctx context.Context, audio []byte, filename string) (string, string, error) {
	allowed := s.Voice.STTLanguages
	if len(allowed) == 0 {
		return s.whisper(ctx, audio, filename, s.Voice.STTLanguage)
	}
	text, got, err := s.whisper(ctx, audio, filename, "")
	if err != nil || slices.Contains(allowed, got) {
		return text, got, err
	}
	type heard struct{ text, lang string }
	tries := make([]heard, len(allowed))
	errs := make([]error, len(allowed))
	var wg sync.WaitGroup
	for i, l := range allowed {
		wg.Go(func() {
			tries[i].text, _, errs[i] = s.whisper(ctx, audio, filename, l)
			tries[i].lang = l
		})
	}
	wg.Wait()
	pick := 0
	for i, t := range tries {
		if errs[i] == nil && t.lang != "en" && strings.ContainsFunc(t.text, func(r rune) bool { return r > unicode.MaxASCII && unicode.IsLetter(r) }) {
			pick = i
			break
		}
	}
	log.Printf("stt: heard %s, outside %s; took it as %s", got, strings.Join(allowed, ","), tries[pick].lang)
	return tries[pick].text, tries[pick].lang, errs[pick]
}

func (s *Server) whisper(ctx context.Context, audio []byte, filename, lang string) (string, string, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", filename)
	fw.Write(audio)
	mw.WriteField("model", s.Voice.STTModel)
	mw.WriteField("response_format", "verbose_json")
	if lang != "" {
		mw.WriteField("language", lang)
	}
	if s.Voice.STTPrompt != "" {
		mw.WriteField("prompt", s.Voice.STTPrompt)
	}
	mw.Close()
	req, _ := http.NewRequestWithContext(ctx, "POST", s.Voice.STT, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	var out struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}
	err := llm.Do(req, &out)
	return strings.TrimSpace(out.Text), out.Language, err
}

func (s *Server) chat(ctx context.Context, system, user string, maxTokens int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return llm.Chat(ctx, s.Voice.LLM, s.Voice.LLMModel, system, user, maxTokens, false)
}

// speak says text in lang, or in the language its letters give away when lang is empty, with
// that language's own engine when there is one (ATC_TTS_TR_URL) and the default voice otherwise.
func (s *Server) speak(ctx context.Context, text, lang string) (*http.Response, error) {
	sp := Speaker{s.Voice.TTS, s.Voice.TTSModel, s.Voice.TTSVoice}
	if x, ok := s.Voice.Speakers[cmp.Or(lang, spokenIn(text))]; ok {
		sp = Speaker{x.URL, cmp.Or(x.Model, sp.Model), cmp.Or(x.Voice, sp.Voice)}
	}
	b, _ := json.Marshal(map[string]string{"model": sp.Model, "voice": sp.Voice, "input": text, "response_format": "wav"})
	req, _ := http.NewRequestWithContext(ctx, "POST", sp.URL, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := voiceClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(res.Body)
		res.Body.Close()
		return nil, fmt.Errorf("text-to-speech: %s %s", res.Status, msg)
	}
	return res, nil
}

// spokenIn guesses the language of a text from the letters only Turkish (of tr and en) has.
func spokenIn(text string) string {
	if strings.ContainsAny(text, "ıİşŞğĞçÇöÖüÜ") {
		return "tr"
	}
	return ""
}
