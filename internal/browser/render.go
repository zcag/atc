package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

// Render draws an HTML document in a tab of its own, closed again right after, and returns
// its body as a PNG at twice the size: width is the viewport, the body sets the crop.
func (b *Browser) Render(ctx context.Context, html string, width int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ws, err := b.wsURL(ctx)
	if err != nil {
		return nil, err
	}
	up, _, err := websocket.Dial(ctx, ws, nil)
	if err != nil {
		return nil, err
	}
	defer up.CloseNow()
	up.SetReadLimit(-1)
	c := &cdp{ws: up, wait: map[int64]chan message{}}
	go c.read(ctx, func(message) {})

	var target struct{ TargetID string }
	if err := c.into(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank", "background": true}, &target); err != nil {
		return nil, err
	}
	defer c.call(context.WithoutCancel(ctx), "", "Target.closeTarget", map[string]string{"targetId": target.TargetID})
	var att struct{ SessionID string }
	if err := c.into(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target.TargetID, "flatten": true}, &att); err != nil {
		return nil, err
	}
	s := att.SessionID
	if _, err := c.call(ctx, s, "Emulation.setDeviceMetricsOverride", map[string]any{"width": width, "height": 300, "deviceScaleFactor": 2, "mobile": false}); err != nil {
		return nil, err
	}
	var tree struct {
		FrameTree struct{ Frame struct{ ID string } }
	}
	if err := c.into(ctx, s, "Page.getFrameTree", nil, &tree); err != nil {
		return nil, err
	}
	if _, err := c.call(ctx, s, "Page.setDocumentContent", map[string]string{"frameId": tree.FrameTree.Frame.ID, "html": html}); err != nil {
		return nil, err
	}
	var size struct {
		Result struct{ Value struct{ W, H float64 } }
	}
	measure := `document.fonts.ready.then(() => { const r = document.body.getBoundingClientRect(); return {w: Math.ceil(r.right), h: Math.ceil(r.bottom)} })`
	if err := c.into(ctx, s, "Runtime.evaluate", map[string]any{"expression": measure, "awaitPromise": true, "returnByValue": true}, &size); err != nil {
		return nil, err
	}
	var shot struct{ Data string }
	clip := map[string]any{"x": 0, "y": 0, "width": max(size.Result.Value.W, 1), "height": max(size.Result.Value.H, 1), "scale": 1}
	if err := c.into(ctx, s, "Page.captureScreenshot", map[string]any{"format": "png", "clip": clip, "captureBeyondViewport": true}, &shot); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(shot.Data)
}

func (c *cdp) into(ctx context.Context, session, method string, params, out any) error {
	raw, err := c.call(ctx, session, method, params)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}
