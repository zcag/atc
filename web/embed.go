package web

import "embed"

//go:embed index.html app.js style.css sw.js manifest.webmanifest icon.svg icon-192.png icon-512.png apple-touch-icon.png vendor
var FS embed.FS
