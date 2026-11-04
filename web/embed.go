package web

import "embed"

//go:embed index.html app.js call.js call-worklet.js persona.js rig.js usage-cube.js res-parts.js minimal.js motion.js persona.html atc.js atc.css tokens.css themes style.css chrome.css session.css board.css transcript.css settings.css pages.css screens.css assistant.css icon.svg vendor
var FS embed.FS
