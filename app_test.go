package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestFetchAppChecksTheChecksum(t *testing.T) {
	apk := []byte("apk bytes")
	sum := sha256.Sum256(apk)
	version := `{"versionName":"0.1","sha256":"` + hex.EncodeToString(sum[:]) + `"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/version.json" {
			w.Write([]byte(version))
			return
		}
		w.Write(apk)
	}))
	defer srv.Close()
	dir := t.TempDir()
	if name, err := fetchApp(srv.URL+"/", dir); err != nil || name != "0.1" {
		t.Fatal(name, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "atc.apk")); string(b) != string(apk) {
		t.Fatal("apk not saved")
	}
	apk = []byte("tampered")
	other := t.TempDir()
	if _, err := fetchApp(srv.URL+"/", other); err == nil {
		t.Fatal("a wrong checksum must fail")
	}
	if _, err := os.Stat(filepath.Join(other, "atc.apk")); err == nil {
		t.Fatal("a bad download must not be kept")
	}
}
