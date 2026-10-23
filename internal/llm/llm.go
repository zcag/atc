package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var client = &http.Client{Timeout: 90 * time.Second}

func Chat(ctx context.Context, url, model, system, user string, maxTokens int, jsonOut bool) (string, error) {
	body := map[string]any{
		"model": model, "temperature": 0.2, "max_tokens": maxTokens,
		"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
	}
	if jsonOut {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	var out struct {
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	if err := Do(req, &out); err != nil {
		return "", err
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("%s: empty answer", req.URL.Host)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func Do(req *http.Request, out any) error {
	res, err := client.Do(req)
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
