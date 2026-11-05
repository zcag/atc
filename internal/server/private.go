package server

import (
	"log"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
)

var tailnetRange = netip.MustParsePrefix("100.64.0.0/10")

func privateIP(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsLoopback() || a.IsPrivate() || tailnetRange.Contains(a)
}

// PrivateOnly refuses anyone not on this machine, a local network or a tailnet. It is what lets atc listen on every
// interface by default without answering the internet on a machine with a public address.
func PrivateOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ap, err := netip.ParseAddrPort(r.RemoteAddr)
		if err != nil || !privateIP(ap.Addr()) {
			log.Printf("refused %s from a public address %s", r.URL.Path, r.RemoteAddr)
			http.Error(w, "atc only answers on this machine, a local network or a tailnet: https://github.com/zcag/atc/blob/master/docs/install.md#reach-it-from-other-devices", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func reachRank(name string, a netip.Addr) int {
	a = a.Unmap()
	if !a.Is4() || a.IsLoopback() || !privateIP(a) {
		return 0
	}
	if slices.ContainsFunc([]string{"docker", "br-", "veth", "virbr", "podman", "lo"}, func(p string) bool { return strings.HasPrefix(name, p) }) {
		return 0
	}
	if tailnetRange.Contains(a) {
		return 2
	}
	return 1
}

// ReachableIP is the address another device is most likely to reach this machine at: its tailnet address, else its local
// network's, else "".
func ReachableIP() string {
	ifaces, _ := net.Interfaces()
	best, rank := "", 0
	for _, i := range ifaces {
		if i.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			p, err := netip.ParsePrefix(a.String())
			if err != nil {
				continue
			}
			if r := reachRank(i.Name, p.Addr()); r > rank {
				best, rank = p.Addr().Unmap().String(), r
			}
		}
	}
	return best
}
