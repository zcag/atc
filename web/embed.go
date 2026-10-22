package web

import "embed"

//go:embed index.html app.js style.css icon.svg vendor
var FS embed.FS
