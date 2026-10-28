package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/zcag/atc/internal/llm"
)

type Voice struct {
	STT, STTModel, STTPrompt string
	TTS, TTSModel, TTSVoice  string
	LLM, LLMModel            string
}

func VoiceFromEnv() Voice {
	return Voice{
		STT: os.Getenv("ATC_STT_URL"), STTModel: cmp.Or(os.Getenv("ATC_STT_MODEL"), "whisper-1"), STTPrompt: os.Getenv("ATC_STT_PROMPT"),
		TTS: os.Getenv("ATC_TTS_URL"), TTSModel: cmp.Or(os.Getenv("ATC_TTS_MODEL"), "tts-1"), TTSVoice: cmp.Or(os.Getenv("ATC_TTS_VOICE"), "alloy"),
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

func (s *Server) transcribe(ctx context.Context, audio []byte, filename string) (string, string, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", filename)
	fw.Write(audio)
	mw.WriteField("model", s.Voice.STTModel)
	mw.WriteField("response_format", "verbose_json")
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
