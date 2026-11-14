package main

import (
	"strings"
	"testing"
)

func TestBoardCardsFoldsInWhatAgentsAdded(t *testing.T) {
	raw := []byte(`{
		"cards": [
			{"id":"a","title":"kept second","lane":"in","pos":2},
			{"id":"b","title":"no","lane":"out","pos":1},
			{"id":"c","title":"kept first","lane":"in","pos":1}
		],
		"seen": ["a","b","c","gone"],
		"proposed": [
			{"id":"a","title":"kept second","source":"agent"},
			{"id":"gone","title":"deleted on the page","source":"agent"},
			{"id":"new","title":"not looked at yet","source":"agent","author":"@shop"}
		]
	}`)
	var got []string
	for _, c := range boardCards(raw) {
		got = append(got, c.Lane+":"+c.Title)
	}
	want := "in:kept first|in:kept second|unsorted:not looked at yet|out:no"
	if strings.Join(got, "|") != want {
		t.Fatalf("got  %s\nwant %s", strings.Join(got, "|"), want)
	}
}
