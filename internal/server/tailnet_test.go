package server

import (
	"net"
	"strings"
	"testing"
	"time"
)

func TestProxyGatewayCountsAsHidden(t *testing.T) {
	p := ParseProxies("docker:proxy")
	p.ips = map[string]bool{"172.30.0.5": true}
	p.gateways = map[string]bool{"172.30.0.1": true}
	p.at = time.Now()
	if !p.Hides(net.ParseIP("172.30.0.1")) {
		t.Fatal("the proxy's gateway should count as hiding the client")
	}
	if p.Hides(net.ParseIP("100.64.1.2")) || p.Hides(net.ParseIP("172.30.0.5")) {
		t.Fatal("a tailnet address or the proxy itself is not hidden")
	}
	if ParseProxies("10.0.0.0/8").Hides(net.ParseIP("10.0.0.1")) {
		t.Fatal("a CIDR proxy has no known gateway")
	}
}

func TestHiddenShowsWhileRecentAndTellsOnce(t *testing.T) {
	s := &Server{}
	if s.hiddenNow() != "" {
		t.Fatal("nothing seen yet")
	}
	s.noteHidden(net.ParseIP("172.30.0.1"))
	told := s.hidden.told
	if !strings.HasPrefix(s.hiddenNow(), "172.30.0.1 at ") || told.IsZero() {
		t.Fatalf("got %q, told %v", s.hiddenNow(), told)
	}
	s.noteHidden(net.ParseIP("172.30.0.1"))
	if s.hidden.told != told {
		t.Fatal("told twice within the hour")
	}
	s.hidden.at = time.Now().Add(-hiddenFor - time.Second)
	if s.hiddenNow() != "" {
		t.Fatal("an old sighting should not show")
	}
}
