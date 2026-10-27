package browser

import (
	"encoding/json"
	"testing"
)

func event(method string, params any) message {
	raw, _ := json.Marshal(params)
	return message{Method: method, Params: raw}
}

func attached(session, target, opener string) message {
	return event("Target.attachedToTarget", map[string]any{"sessionId": session, "waitingForDebugger": true,
		"targetInfo": map[string]string{"targetId": target, "type": "page", "openerId": opener}})
}

func TestFilter(t *testing.T) {
	b, _ := Open("", "")
	b.claim("mine", "a")
	b.claim("theirs", "b")
	c := &conn{b: b, sid: "a", creating: map[int64]bool{}, listing: map[int64]bool{}, hidden: map[string]bool{}, foreign: map[string]bool{}, next: ownID}

	if keep, _ := c.filter(attached("s1", "mine", "")); keep == nil {
		t.Fatal("own tab hidden")
	}
	keep, extra := c.filter(attached("s2", "theirs", ""))
	if keep != nil || len(extra) != 2 || extra[0].Method != "Runtime.runIfWaitingForDebugger" || extra[1].Method != "Target.detachFromTarget" {
		t.Fatalf("another session's tab: keep=%v extra=%v", keep, extra)
	}
	if keep, _ := c.filter(message{Method: "Page.frameNavigated", SessionID: "s2"}); keep != nil {
		t.Fatal("event from a hidden tab passed")
	}
	if keep, _ := c.filter(attached("s3", "unowned", "")); keep != nil {
		t.Fatal("a tab nobody opened is shown")
	}
	if keep, _ := c.filter(attached("s4", "popup", "mine")); keep == nil || b.Owner("popup") != "a" {
		t.Fatal("a popup from an own tab is not the session's")
	}
	if keep, _ := c.filter(event("Target.attachedToTarget", map[string]any{"sessionId": "s5", "targetInfo": map[string]string{"targetId": "sw", "type": "service_worker"}})); keep == nil {
		t.Fatal("non-tab targets pass through")
	}

	id := int64(7)
	c.listing[id] = true
	res, _ := json.Marshal(map[string]any{"targetInfos": []map[string]string{{"targetId": "mine", "type": "page"}, {"targetId": "theirs", "type": "page"}}})
	keep, _ = c.filter(message{ID: &id, Result: res})
	var r struct{ TargetInfos []targetInfo }
	json.Unmarshal(keep.Result, &r)
	if len(r.TargetInfos) != 1 || r.TargetInfos[0].TargetID != "mine" {
		t.Fatalf("getTargets: %+v", r.TargetInfos)
	}

	if keep, _ := c.filter(event("Target.targetDestroyed", map[string]string{"targetId": "mine"})); keep == nil || b.Owner("mine") != "" {
		t.Fatal("closed own tab should pass and be forgotten")
	}
}
