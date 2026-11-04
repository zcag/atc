#!/bin/sh
set -eu
repo=zcag/atc
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "atc runs on Linux and macOS" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac
base="https://github.com/$repo/releases/latest/download"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
file="atc-$os-$arch.tar.gz"
curl -fsSL "$base/$file" -o "$tmp/$file"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"
(cd "$tmp" && grep " $file\$" checksums.txt | { sha256sum -c - 2>/dev/null || shasum -a 256 -c -; } >/dev/null)
tar -xzf "$tmp/$file" -C "$tmp"
"$tmp/atc" service install
"$HOME/.local/bin/atc" setup
