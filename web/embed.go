package web

import "embed"

//go:embed index.html app.js atc.js style.css icon.svg vendor
var FS embed.FS
