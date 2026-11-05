package tools

import (
	"strings"
	"testing"

	"github.com/zcag/atc/internal/history"
)

func TestRenderShowsMidTurnMessages(t *testing.T) {
	got := render([]history.Message{
		{Role: "user", Text: "fix it"},
		{Role: "tool"},
		{Role: "note", Text: "also check the tests"},
		{Role: "assistant", Text: "Done."},
	}, 2)
	want := "USER (mid-turn): also check the tests\nCLAUDE: Done.\n"
	if !strings.Contains(got, want) || strings.Contains(got, "fix it") {
		t.Fatalf("got %q", got)
	}
}
