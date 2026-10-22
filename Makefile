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

.PHONY: build check install
