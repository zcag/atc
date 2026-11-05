package hub

import (
	"context"
	"slices"
)

// withNews puts what changed in atc in front of a message: the whole state on the first message of
// a conversation and whenever the channel changes (a call starting), else only what is new.
func (h *Hub) withNews(ch, text string) string {
	if h.cfg.News == nil || ch == reset || guest(ch) {
		return text
	}
	news := h.cfg.News(h.fresh || !aside(ch) && ch != h.last)
	if news == "" {
		return text
	}
	h.fresh = false
	return news + "\n\n" + text
}

// Notice is atc saying a session now needs the user. While a phone turn is running a tool, the change
// joins that turn right away, so the assistant can weigh it into what the user is about to hear; otherwise
// the next message carries it, since a call only speaks answers to the user's own words.
func (h *Hub) Notice() (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cfg.News == nil || !h.alive || h.handover != nil || h.turn == nil || h.turn.tools <= 0 || !slices.Contains(h.turn.channels, Phone) {
		return false, nil
	}
	news := h.cfg.News(false)
	if news == "" {
		return false, nil
	}
	h.pending = append(h.pending, msg{Phone, news})
	return true, h.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": news}})
}

func (c *Client) Notice(ctx context.Context) (bool, error) {
	var r struct{ Joined bool }
	return r.Joined, c.do(ctx, "POST", "/notice", nil, &r)
}
