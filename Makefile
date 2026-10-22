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

install-mac: check build
	install -m755 atc ~/.local/bin/atc
	install -m644 deploy/atc.plist ~/Library/LaunchAgents/io.github.zcag.atc.plist
	launchctl bootout gui/$$(id -u)/io.github.zcag.atc 2>/dev/null || true
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/io.github.zcag.atc.plist

.PHONY: build check install install-mac
