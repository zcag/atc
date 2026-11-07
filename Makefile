-include $(HOME)/.config/atc/local.mk

build:
	go build -o atc .

check:
	gofmt -l . | (! grep .)
	go vet ./...
	go test ./...
	go run . prompts --check
	@if [ -f ~/.config/atc/private-words ]; then ! git grep --untracked -nIEf ~/.config/atc/private-words -- . ':!LICENSE' ; fi
	if command -v node >/dev/null; then for f in web/*.js; do node --check $$f || exit 1; done; node --test web/*.test.mjs; fi
	if command -v python3 >/dev/null; then python3 voice/test/test_lang.py && python3 voice/test/test_press.py && python3 voice/test/test_turn.py; fi
	if command -v uv >/dev/null; then uv run -q --script voice/test/test_remote.py && uv run -q --script voice/test/test_ring.py; fi

install: check build
	./atc service install --only atc
	$(MAKE) --no-print-directory sync-main

install-hub: check build
	./atc service install --only hub

# A single-user setup: voice/ goes where ~/.config/atc/voice.env says their units run, and deploy.sh restarts them between calls.
install-voice:
	@test -f ~/.config/atc/voice.env || { echo "~/.config/atc/voice.env is missing: without it the units run with no phone, no number and the default voice"; exit 1; }
	@set -a; . ~/.config/atc/voice.env; set +a; d=$${ATC_VOICE_DIR:-$$HOME/.local/share/atc/voice}; mkdir -p "$$d"; \
	  rsync -a --exclude test --exclude __pycache__ voice/ "$$d/" && bash "$$d/deploy.sh"

sync-main:
	@main=$$(cd "$$(git rev-parse --git-common-dir)/.." && pwd); git fetch -q origin; \
	if [ "$$(git -C $$main branch --show-current)" != master ]; then echo "sync-main: $$main is not on master, left alone"; \
	elif [ -n "$$(git -C $$main status --porcelain)" ]; then echo "sync-main: $$main has local changes, left alone"; \
	else git -C $$main merge -q --ff-only origin/master && echo "sync-main: $$main at $$(git -C $$main rev-parse --short HEAD)"; fi

install-opencode: build
	./atc service install --only opencode

install-mac: check build
	./atc service install --only atc

ifeq ($(shell uname),Darwin)
JAVA_HOME ?= /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
ANDROID_HOME ?= $(HOME)/Library/Android/sdk
else
JAVA_HOME ?= $(HOME)/.local/opt/jdk17
ANDROID_HOME ?= $(HOME)/Android/sdk
endif
APP_DIR ?= .local/share/atc/app

android:
	cd android && JAVA_HOME="$(JAVA_HOME)" ANDROID_HOME="$(ANDROID_HOME)" ./gradlew -q testReleaseUnitTest assembleRelease
	mkdir -p android/dist
	cp android/app/build/outputs/apk/release/app-release.apk android/dist/atc.apk
	n=$$(( $$(git rev-list --count HEAD) + $$(cat android/version-base) )); sum=$$( (sha256sum 2>/dev/null || shasum -a 256) < android/dist/atc.apk | cut -d' ' -f1); \
	printf '{"versionCode":%s,"versionName":"0.%s","apk":"/app/atc.apk","sha256":"%s"}\n' $$n $$n $$sum > android/dist/version.json

android-publish:
	@test -n "$(APP_HOST)" || { echo "set APP_HOST: the machine atc serves the app from"; exit 1; }
	ssh $(APP_HOST) mkdir -p $(APP_DIR)
	rsync -t android/dist/atc.apk $(APP_HOST):$(APP_DIR)/
	rsync -t android/dist/version.json $(APP_HOST):$(APP_DIR)/

personas:
	python3 tools/persona/pack.py $${ATC_APP_DIR:-$$HOME/.local/share/atc/app}/personas android/dist

.PHONY: build check install install-hub install-voice install-opencode install-mac android android-publish personas
