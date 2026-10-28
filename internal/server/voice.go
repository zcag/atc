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
	LLM, LLMModel                         string
}

func VoiceFromEnv() Voice {
	return Voice{
		STT: os.Getenv("ATC_STT_URL"), STTModel: cmp.Or(os.Getenv("ATC_STT_MODEL"), "whisper-1"), STTPrompt: os.Getenv("ATC_STT_PROMPT"), STTLanguage: os.Getenv("ATC_STT_LANGUAGE"),
		STTLanguages: strings.FieldsFunc(os.Getenv("ATC_STT_LANGUAGES"), func(r rune) bool { return r == ',' || r == ' ' }),
		TTS:          os.Getenv("ATC_TTS_URL"), TTSModel: cmp.Or(os.Getenv("ATC_TTS_MODEL"), "tts-1"), TTSVoice: cmp.Or(os.Getenv("ATC_TTS_VOICE"), "alloy"),
		LLM: os.Getenv("ATC_SPEECH_LLM_URL"), LLMModel: os.Getenv("ATC_SPEECH_LLM_MODEL"),
	}
}

const condensePrompt = `You turn a coding assistant's reply into what it would say out loud to the person who asked. ` +
	`One to three short spoken sentences, in the reply's own language. Keep the outcome, any question it asks, and anything the person must decide. ` +
	`No code, no markdown, no file paths unless essential, no lists. Do not add anything that is not in the reply.`

var voiceClient = &http.Client{Timeout: 90 * time.Second}

func (s *Server) stt(w http.ResponseWriter, r *http.Request) {
	if s.Voice.STT == "" {
		http.Error(w, "speech-to-text is not configured", http.StatusNotImplemented)
		return
	}
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 20<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	text, lang, err := s.transcribe(r.Context(), audio, "speech.wav")
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"text": text, "language": lang})
}

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

func (s *Server) condense(w http.ResponseWriter, r *http.Request) {
	var in struct{ Text string }
	json.NewDecoder(r.Body).Decode(&in)
	if s.Voice.LLM == "" {
		http.Error(w, "no speech model configured", http.StatusNotImplemented)
		return
	}
	text, err := s.chat(r.Context(), condensePrompt, in.Text, 160)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"text": text})
}

const finishedPrompt = `You judge live speech-to-text from someone talking to an AI assistant. They paused. ` +
	`Decide if what they said so far is a finished message they would send now, or if they stopped mid-thought and will keep talking. ` +
	`Mid-thought: the sentence is cut off, ends on a connecting word (and, but, so, because, the, a, to, with, when, if, that, like, um), ` +
	`or asks something only half-stated. Finished: a complete request, question, answer or reply, even a short one like yes, ok, stop, go ahead. ` +
	`Reply with exactly one word: finished or continuing.`

func (s *Server) finished(w http.ResponseWriter, r *http.Request) {
	var in struct{ Text string }
	json.NewDecoder(r.Body).Decode(&in)
	if s.Voice.LLM == "" {
		http.Error(w, "no speech model configured", http.StatusNotImplemented)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
	defer cancel()
	out, err := llm.Chat(ctx, s.Voice.LLM, s.Voice.LLMModel, finishedPrompt, in.Text, 4, false)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]bool{"finished": !strings.Contains(strings.ToLower(out), "continu")})
}

func (s *Server) chat(ctx context.Context, system, user string, maxTokens int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return llm.Chat(ctx, s.Voice.LLM, s.Voice.LLMModel, system, user, maxTokens, false)
}

func (s *Server) tts(w http.ResponseWriter, r *http.Request) {
	var in struct{ Text string }
	json.NewDecoder(r.Body).Decode(&in)
	if s.Voice.TTS == "" {
		http.Error(w, "text-to-speech is not configured", http.StatusNotImplemented)
		return
	}
	res, err := s.speak(r.Context(), in.Text)
	if err != nil {
		fail(w, err)
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", cmp.Or(res.Header.Get("Content-Type"), "audio/wav"))
	io.Copy(w, res.Body)
}

func (s *Server) speak(ctx context.Context, text string) (*http.Response, error) {
	b, _ := json.Marshal(map[string]string{"model": s.Voice.TTSModel, "voice": s.Voice.TTSVoice, "input": text, "response_format": "wav"})
	req, _ := http.NewRequestWithContext(ctx, "POST", s.Voice.TTS, bytes.NewReader(b))
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
