build:
	go build -o atc .

check:
	gofmt -l . | (! grep .)
	go vet ./...
	go test ./...

install: check build
	install -m755 atc ~/.local/bin/atc
	install -Dm644 deploy/atc.service ~/.config/systemd/user/atc.service
	systemctl --user daemon-reload
	systemctl --user enable --now atc
	systemctl --user restart atc

install-opencode:
	install -Dm644 deploy/opencode/agent/atc.md ~/.config/atc/opencode/agent/atc.md
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

JAVA_HOME ?= /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
ANDROID_HOME ?= $(HOME)/Library/Android/sdk
APP_HOST ?= desktop
APP_DIR ?= .local/share/atc/app

android:
	cd android && JAVA_HOME="$(JAVA_HOME)" ANDROID_HOME="$(ANDROID_HOME)" ./gradlew -q testReleaseUnitTest assembleRelease
	mkdir -p android/dist
	cp android/app/build/outputs/apk/release/app-release.apk android/dist/atc.apk
	n=$$(git rev-list --count HEAD); sum=$$(shasum -a 256 android/dist/atc.apk | cut -d' ' -f1); \
	printf '{"versionCode":%s,"versionName":"0.%s","apk":"/app/atc.apk","sha256":"%s"}\n' $$n $$n $$sum > android/dist/version.json

android-publish:
	ssh $(APP_HOST) mkdir -p $(APP_DIR)
	rsync -t android/dist/atc.apk $(APP_HOST):$(APP_DIR)/
	rsync -t android/dist/version.json $(APP_HOST):$(APP_DIR)/

.PHONY: build check install install-opencode install-mac android android-publish
