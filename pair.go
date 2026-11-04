package main

import (
	"cmp"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/zcag/atc/internal/client"
	"github.com/zcag/atc/internal/pair"
	"github.com/zcag/atc/internal/server"
)

func thisMachine() string {
	host, _ := os.Hostname()
	return strings.Split(host, ".")[0]
}

func login(args []string) error {
	switch {
	case len(args) == 1:
		p, err := pair.Parse(args[0])
		if err != nil {
			return err
		}
		r, err := pair.Redeem(p, thisMachine())
		if err != nil {
			return err
		}
		if err := client.SaveLogin(p.URL, r.Token, r.CA); err != nil {
			return err
		}
		fmt.Printf("logged in to %s as %s\n", p.URL, thisMachine())
		return nil
	case len(args) == 2:
		return client.SaveLogin(args[0], args[1], "")
	}
	log.Fatal("usage: atc login <url> <token>\n       atc login <pairing>")
	return nil
}

func pairCmd(args []string) error {
	fs, asJSON := jsonFlag("pair", args)
	url := fs.String("url", "", "the server address the new device will reach")
	fs.Parse(args)
	text, err := client.Load().Pairing(*url)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(map[string]string{"payload": text})
	}
	p, err := pair.Parse(text)
	if err != nil {
		return err
	}
	if qr, err := pair.Terminal(text); err == nil {
		fmt.Print(qr)
	}
	fmt.Printf("\n%s\n\nValid %d minutes, one use, for %s.\nScan it in the Android app, or on another machine:\n  atc login '%s'\n  atc peer add '%s'\n",
		text, int(pair.CodeLife.Minutes()), p.URL, text, text)
	return nil
}

func peerCmd(args []string) error {
	if len(args) == 0 || args[0] != "add" {
		return errors.New("usage: atc peer add [-name N] <pairing>")
	}
	fs := flag.NewFlagSet("peer add", flag.ExitOnError)
	name := fs.String("name", "", "what to call it, by default the name it reports")
	fs.Parse(args[1:])
	if fs.NArg() != 1 {
		return errors.New("usage: atc peer add [-name N] <pairing>")
	}
	p, err := pair.Parse(fs.Arg(0))
	if err != nil {
		return err
	}
	r, err := pair.Redeem(p, thisMachine())
	if err != nil {
		return err
	}
	peer := server.Peer{Name: cmp.Or(*name, r.Host), URL: p.URL, Token: r.Token, CA: r.CA}
	if peer.Name == "" {
		return errors.New("the other machine reports no name: pass -name")
	}
	os.MkdirAll(client.ConfigDir(), 0o700)
	if err := server.SavePeer(filepath.Join(client.ConfigDir(), "peers.json"), peer); err != nil {
		return err
	}
	fmt.Printf("added peer %s at %s; restart atc to pick it up\n", peer.Name, peer.URL)
	return nil
}
