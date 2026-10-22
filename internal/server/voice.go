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
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "speech.wav")
	fw.Write(audio)
	mw.WriteField("model", s.Voice.STTModel)
	mw.WriteField("response_format", "verbose_json")
	if s.Voice.STTPrompt != "" {
		mw.WriteField("prompt", s.Voice.STTPrompt)
	}
	mw.Close()
	req, _ := http.NewRequestWithContext(r.Context(), "POST", s.Voice.STT, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	var out struct {
		Text     string `json:"text"`
		Language string `json:"language"`
	}
	if err := call(req, &out); err != nil {
		fail(w, err)
		return
	}
	reply(w, map[string]string{"text": strings.TrimSpace(out.Text), "language": out.Language})
}

func (s *Server) condense(w http.ResponseWriter, r *http.Request) {
	var in struct{ Text string }
	json.NewDecoder(r.Body).Decode(&in)
	if s.Voice.LLM == "" {
		http.Error(w, "no speech model configured", http.StatusNotImplemented)
		return
	}
	b, _ := json.Marshal(map[string]any{
		"model": s.Voice.LLMModel, "temperature": 0.2, "max_tokens": 160,
		"messages": []map[string]string{{"role": "system", "content": condensePrompt}, {"role": "user", "content": in.Text}},
	})
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", s.Voice.LLM, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	var out struct {
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	if err := call(req, &out); err != nil || len(out.Choices) == 0 {
		fail(w, cmp.Or(err, fmt.Errorf("empty answer from the speech model")))
		return
	}
	reply(w, map[string]string{"text": strings.TrimSpace(out.Choices[0].Message.Content)})
}

func (s *Server) tts(w http.ResponseWriter, r *http.Request) {
	var in struct{ Text string }
	json.NewDecoder(r.Body).Decode(&in)
	if s.Voice.TTS == "" {
		http.Error(w, "text-to-speech is not configured", http.StatusNotImplemented)
		return
	}
	b, _ := json.Marshal(map[string]string{"model": s.Voice.TTSModel, "voice": s.Voice.TTSVoice, "input": in.Text, "response_format": "wav"})
	req, _ := http.NewRequestWithContext(r.Context(), "POST", s.Voice.TTS, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := voiceClient.Do(req)
	if err != nil {
		fail(w, err)
		return
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(res.Body)
		http.Error(w, fmt.Sprintf("text-to-speech: %s %s", res.Status, msg), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", cmp.Or(res.Header.Get("Content-Type"), "audio/wav"))
	io.Copy(w, res.Body)
}

func call(req *http.Request, out any) error {
	res, err := voiceClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		msg, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%s: %s %s", req.URL.Host, res.Status, bytes.TrimSpace(msg))
	}
	return json.NewDecoder(res.Body).Decode(out)
}
