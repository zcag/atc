package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/zcag/atc/internal/browser"
	"github.com/zcag/atc/internal/client"
)

const browserHelp = `atc browser: the shared browser, one session's tabs at a time.

  atc browser mcp [playwright-mcp flags...]
      Playwright's MCP server, connected to the browser atc shares (ATC_BROWSER on the
      server) as this session: it sees and drives only the tabs this session opened,
      and the user can watch and take over those tabs in atc. Playwright starts on the
      session's first browser call; until then atc answers from its last tool list.
      Use it as the command of a browser MCP server:
        claude mcp add -s user browser -- atc browser mcp
`

const playwrightMCP = "@playwright/mcp@latest"

func browserCmd(args []string) error {
	if len(args) == 0 || args[0] != "mcp" {
		fmt.Print(browserHelp)
		return nil
	}
	sid := os.Getenv("CLAUDE_CODE_SESSION_ID")
	if sid == "" {
		return fmt.Errorf("not inside a Claude session, so atc can't tell whose tabs these are")
	}
	npx, err := exec.LookPath("npx")
	if err != nil {
		return err
	}
	c := client.Load()
	ws := "ws" + strings.TrimPrefix(c.URL, "http") + "/api/browser/" + sid + "/cdp"
	if slices.ContainsFunc(args[1:], func(a string) bool { return a == "--config" || strings.HasPrefix(a, "--config=") }) {
		return fmt.Errorf("atc browser mcp passes Playwright its own --config, so it can't take yours")
	}
	config, err := cdpConfig(c.Token)
	if err != nil {
		return err
	}
	argv := append([]string{npx, "-y", playwrightMCP, "--cdp-endpoint", ws}, args[1:]...)
	cache, _ := os.UserCacheDir()
	key := append([]string{playwrightMCP}, args[1:]...)
	return browser.LazyMCP(argv, append(os.Environ(), "npm_config_loglevel=error"), key, config,
		filepath.Join(cache, "atc", "browser-mcp.json"), os.Stdin, os.Stdout)
}

func cdpConfig(token string) ([]byte, error) {
	if token == "" {
		return nil, nil
	}
	return json.Marshal(map[string]any{"browser": map[string]any{"cdpHeaders": map[string]string{"Authorization": "Bearer " + token}}})
}
