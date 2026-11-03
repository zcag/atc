package web

import "embed"

//go:embed index.html app.js call.js call-worklet.js persona.js rig.js minimal.js motion.js persona.html atc.js atc.css tokens.css themes style.css settings.css icon.svg vendor
var FS embed.FS
