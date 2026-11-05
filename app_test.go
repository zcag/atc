package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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

func TestUntarPersonasStaysInItsFolder(t *testing.T) {
	pack := func(name string) []byte {
		var b bytes.Buffer
		gz := gzip.NewWriter(&b)
		tw := tar.NewWriter(gz)
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
		tw.Write([]byte("hi"))
		tw.Close()
		gz.Close()
		return b.Bytes()
	}
	dir := t.TempDir()
	if err := untarPersonas(pack("woman/persona.json"), dir); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "woman", "persona.json")); string(b) != "hi" {
		t.Fatalf("%q", b)
	}
	if err := untarPersonas(pack("../evil"), dir); err == nil {
		t.Fatal("a path out of the folder must fail")
	}
	if err := untarPersonas(pack("/evil"), dir); err == nil {
		t.Fatal("an absolute path must fail")
	}
}
