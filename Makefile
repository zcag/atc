-include $(HOME)/.config/atc/local.mk

build:
	go build -o atc .

check:
	gofmt -l . | (! grep .)
	go vet ./...
	go test ./...
	go run . prompts --check
	if command -v node >/dev/null; then node --test web/; fi

install: check build
	install -m755 atc ~/.local/bin/atc
	install -Dm644 deploy/atc.service ~/.config/systemd/user/atc.service
	install -Dm644 deploy/claude.slice ~/.config/systemd/user/claude.slice
	systemctl --user daemon-reload
	systemctl --user enable --now atc
	@$(MAKE) --no-print-directory call-idle
	systemctl --user restart atc
	$(MAKE) --no-print-directory sync-main

# The phone app's calls run through atc (/api/call/line): a restart mid-call cuts the voice for over a second.
# Wait for the call line's app line to be free, up to 30 min; no call line, no wait.
call-idle:
	@for i in $$(seq 360); do \
	  curl -sf --max-time 3 127.0.0.1:8807/status | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("app") is not None)' && exit 0; \
	  curl -sf --max-time 3 -o /dev/null 127.0.0.1:8807/status || exit 0; \
	  echo "an app call is on, atc waits to restart"; sleep 5; \
	done; echo "app call still on after 30 min, restarting anyway"

install-hub: check build
	install -m755 atc ~/.local/bin/atc-hub
	install -Dm644 deploy/atc-hub.service ~/.config/systemd/user/atc-hub.service
	systemctl --user daemon-reload
	systemctl --user enable atc-hub
	systemctl --user restart atc-hub

sync-main:
	@main=$$(cd "$$(git rev-parse --git-common-dir)/.." && pwd); git fetch -q origin; \
	if [ "$$(git -C $$main branch --show-current)" != master ]; then echo "sync-main: $$main is not on master, left alone"; \
	elif [ -n "$$(git -C $$main status --porcelain)" ]; then echo "sync-main: $$main has local changes, left alone"; \
	else git -C $$main merge -q --ff-only origin/master && echo "sync-main: $$main at $$(git -C $$main rev-parse --short HEAD)"; fi

install-opencode:
	test -e ~/.config/atc/opencode/agent/atc.md || install -Dm644 deploy/opencode/agent/atc.md ~/.config/atc/opencode/agent/atc.md
	install -m644 deploy/opencode/opencode.json ~/.config/atc/opencode/opencode.json
	test -e ~/.config/atc/opencode/config.json || ln -s ~/.config/opencode/config.json ~/.config/atc/opencode/config.json
	install -Dm644 deploy/opencode.service ~/.config/systemd/user/opencode.service
	systemctl --user daemon-reload
	systemctl --user enable opencode
	systemctl --user restart opencode

install-mac: check build
	install -m755 atc ~/.local/bin/atc
	install -m644 deploy/atc.plist ~/Library/LaunchAgents/io.github.zcag.atc.plist
	launchctl bootout gui/$$(id -u)/io.github.zcag.atc 2>/dev/null || true
	while launchctl print gui/$$(id -u)/io.github.zcag.atc >/dev/null 2>&1; do sleep 0.2; done
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/io.github.zcag.atc.plist

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
	n=$$(git rev-list --count HEAD); sum=$$( (sha256sum 2>/dev/null || shasum -a 256) < android/dist/atc.apk | cut -d' ' -f1); \
	printf '{"versionCode":%s,"versionName":"0.%s","apk":"/app/atc.apk","sha256":"%s"}\n' $$n $$n $$sum > android/dist/version.json

android-publish:
	@test -n "$(APP_HOST)" || { echo "set APP_HOST: the machine atc serves the app from"; exit 1; }
	ssh $(APP_HOST) mkdir -p $(APP_DIR)
	rsync -t android/dist/atc.apk $(APP_HOST):$(APP_DIR)/
	rsync -t android/dist/version.json $(APP_HOST):$(APP_DIR)/

.PHONY: call-idle build check install install-hub install-opencode install-mac android android-publish
