package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	argv := []string{npx, "-y", playwrightMCP, "--cdp-endpoint", ws}
	if c.Token != "" {
		argv = append(argv, "--cdp-header", "Authorization: Bearer "+c.Token)
	}
	argv = append(argv, args[1:]...)
	cache, _ := os.UserCacheDir()
	key := append([]string{playwrightMCP}, args[1:]...)
	return browser.LazyMCP(argv, append(os.Environ(), "npm_config_loglevel=error"), key,
		filepath.Join(cache, "atc", "browser-mcp.json"), os.Stdin, os.Stdout)
}
