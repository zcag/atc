# Third-party code

What atc bundles and what it builds on, with each licence. atc itself is under the [MIT licence](LICENSE).

Go licences were read from each module's licence file, Android licences from each artifact's POM.
The bundled JavaScript has no licence file of its own in the tree: its licence comes from the file's
header where it has one, and from the npm package otherwise.

## Bundled in the web page (`web/vendor`)

| What | Version | Licence | Copyright | Source of the licence |
|---|---|---|---|---|
| xterm.js (`xterm.js`, `xterm.css`) | not recorded in the file | MIT | The xterm.js authors; Christopher Jeffrey | header of `xterm.css`, npm `@xterm/xterm` |
| xterm addons: clipboard, fit, unicode11, web-links | not recorded in the files | MIT | The xterm.js authors | npm `@xterm/addon-*` |
| Preact, in `preact-htm.js` | not recorded in the file | MIT | Jason Miller | npm `preact` |
| htm, in `preact-htm.js` | not recorded in the file | Apache-2.0 | Jason Miller | npm `htm` |
| marked (`marked.esm.js`) | 12.0.2 | MIT | Christopher Jeffrey | file header |
| highlight.js (`highlight.min.js`) | 11.9.0 | BSD-3-Clause | Ivan Sagalaev and other contributors | file header |
| jsdiff (`diff.mjs`) | not recorded in the file | BSD-3-Clause | Kevin Decker | npm `diff` |
| Recursive font, subset (`fonts/recursive-*.woff2`) | | OFL-1.1 | The Recursive Project Authors | `web/vendor/fonts/OFL.txt` |
| Literata font, subset (`fonts/literata-*.woff2`) | | OFL-1.1 | The Literata Project Authors | `web/vendor/fonts/OFL.txt` |

`web/themes/` uses the colours of Catppuccin (Frappé), Rosé Pine (Dawn) and Nord. No code from them.

## Compiled into the binary (Go)

Every module `go list -deps ./...` reaches, at the versions in `go.mod`.

| Module | Version | Licence | Copyright |
|---|---|---|---|
| github.com/atotto/clipboard | v0.1.4 | BSD-3-Clause | Ato Araki |
| github.com/aymanbagabas/go-osc52/v2 | v2.0.1 | MIT | Ayman Bagabas |
| github.com/charmbracelet/bubbles | v1.0.0 | MIT | Charmbracelet, Inc |
| github.com/charmbracelet/bubbletea | v1.3.10 | MIT | Charmbracelet, Inc |
| github.com/charmbracelet/colorprofile | v0.4.1 | MIT | Charmbracelet, Inc |
| github.com/charmbracelet/lipgloss | v1.1.0 | MIT | Charmbracelet, Inc |
| github.com/charmbracelet/x/ansi | v0.11.9 | MIT | Charmbracelet, Inc |
| github.com/charmbracelet/x/cellbuf | v0.0.15 | MIT | Charmbracelet, Inc |
| github.com/charmbracelet/x/term | v0.2.2 | MIT | Charmbracelet, Inc |
| github.com/clipperhouse/displaywidth | v0.11.0 | MIT | Matt Sherman |
| github.com/clipperhouse/uax29/v2 | v2.7.0 | MIT | Matt Sherman |
| github.com/coder/websocket | v1.8.15 | ISC | Coder |
| github.com/creack/pty | v1.1.24 | MIT | Keith Rarick |
| github.com/google/jsonschema-go | v0.4.3 | MIT | JSON Schema Go Project Authors |
| github.com/lucasb-eyer/go-colorful | v1.4.1 | MIT | Lucas Beyer |
| github.com/mattn/go-isatty | v0.0.20 | MIT | Yasuhiro Matsumoto |
| github.com/mattn/go-runewidth | v0.0.27 | MIT | Yasuhiro Matsumoto |
| github.com/modelcontextprotocol/go-sdk | v1.8.0 | Apache-2.0 for new contributions, MIT for older ones, CC-BY-4.0 for its docs | its contributors |
| github.com/muesli/ansi | v0.0.0-20230316100256-276c6243b2f6 | MIT | Christian Muehlhaeuser |
| github.com/muesli/cancelreader | v0.2.2 | MIT | Erik Geiser, Christian Muehlhaeuser |
| github.com/muesli/termenv | v0.16.0 | MIT | Christian Muehlhaeuser |
| github.com/rivo/uniseg | v0.4.7 | MIT | Oliver Kuederle |
| github.com/sahilm/fuzzy | v0.1.3 | MIT | Sahil Muthoo |
| github.com/segmentio/asm | v1.1.3 | MIT | Segment |
| github.com/segmentio/encoding | v0.5.4 | MIT | Segment.io, Inc. |
| github.com/xo/terminfo | v0.0.0-20220910002029-abceb7e1c41e | MIT | Anmol Sethi |
| github.com/yosida95/uritemplate/v3 | v3.0.2 | BSD-3-Clause | Kohei Yoshida |
| golang.org/x/oauth2 | v0.35.0 | BSD-3-Clause | The Go Authors |
| golang.org/x/sync | v0.20.0 | BSD-3-Clause | The Go Authors |
| golang.org/x/sys | v0.49.0 | BSD-3-Clause | The Go Authors |
| golang.org/x/term | v0.47.0 | BSD-3-Clause | The Go Authors |
| golang.org/x/time | v0.15.0 | BSD-3-Clause | The Go Authors |
| rsc.io/qr | v0.2.0 | BSD-3-Clause | The Go Authors |

The Go standard library is BSD-3-Clause.

## In the Android app

The release runtime classpath (`gradlew :app:dependencies --configuration releaseRuntimeClasspath`).

| Artifact | Version | Licence |
|---|---|---|
| androidx.activity:activity | 1.2.0 | Apache-2.0 |
| androidx.annotation:annotation, annotation-jvm | 1.9.0 | Apache-2.0 |
| androidx.annotation:annotation-experimental | 1.4.1 | Apache-2.0 |
| androidx.arch.core:core-common, core-runtime | 2.2.0 | Apache-2.0 |
| androidx.car.app:app | 1.7.0 | Apache-2.0 |
| androidx.collection:collection, collection-jvm | 1.4.2 | Apache-2.0 |
| androidx.concurrent:concurrent-futures | 1.1.0 | Apache-2.0 |
| androidx.core:core, core-ktx | 1.15.0 | Apache-2.0 |
| androidx.core:core-remoteviews | 1.1.0 | Apache-2.0 |
| androidx.interpolator:interpolator | 1.0.0 | Apache-2.0 |
| androidx.lifecycle:lifecycle-common, -common-java8, -livedata-core, -runtime, -viewmodel, -viewmodel-savedstate | 2.6.2 | Apache-2.0 |
| androidx.media:media | 1.6.0 | Apache-2.0 |
| androidx.profileinstaller:profileinstaller | 1.3.0 | Apache-2.0 |
| androidx.savedstate:savedstate | 1.2.1 | Apache-2.0 |
| androidx.startup:startup-runtime | 1.1.1 | Apache-2.0 |
| androidx.tracing:tracing | 1.2.0 | Apache-2.0 |
| androidx.versionedparcelable:versionedparcelable | 1.1.1 | Apache-2.0 |
| com.google.android.filament:filament-android, filament-utils-android, gltfio-android | 1.75.1 | Apache-2.0 |
| com.google.code.findbugs:jsr305 | 3.0.2 | Apache-2.0 |
| com.google.code.gson:gson | 2.13.2 | Apache-2.0 |
| com.google.crypto.tink:tink | 1.23.0 | Apache-2.0 |
| com.google.errorprone:error_prone_annotations | 2.41.0 | Apache-2.0 |
| com.google.guava:failureaccess | 1.0.1 | Apache-2.0 |
| com.google.guava:guava | 31.1-android | Apache-2.0 |
| com.google.guava:listenablefuture | 9999.0-empty-to-avoid-conflict-with-guava | Apache-2.0 |
| com.google.j2objc:j2objc-annotations | 1.3 | Apache-2.0 |
| com.google.protobuf:protobuf-java | 4.33.6 | BSD-3-Clause |
| com.google.zxing:core | 3.4.1 | Apache-2.0 |
| com.journeyapps:zxing-android-embedded | 4.3.0 | Apache-2.0 |
| com.squareup.okhttp3:okhttp | 4.12.0 | Apache-2.0 |
| com.squareup.okio:okio, okio-jvm | 3.6.0 | Apache-2.0 |
| org.checkerframework:checker-qual | 3.12.0 | MIT |
| org.jetbrains:annotations | 23.0.0 | Apache-2.0 |
| org.jetbrains.kotlin:kotlin-stdlib, kotlin-stdlib-common | 2.2.21 | Apache-2.0 |
| org.jetbrains.kotlin:kotlin-stdlib-jdk7, kotlin-stdlib-jdk8 | 2.0.21 | Apache-2.0 |
| org.jetbrains.kotlinx:kotlinx-coroutines-android, -bom, -core, -core-jvm | 1.9.0 | Apache-2.0 |
| org.jspecify:jspecify | 1.0.0 | Apache-2.0 |
| org.unifiedpush.android:connector | 3.3.5 | Apache-2.0 |

`android/app/src/main/assets` does not exist. Some icons in `android/app/src/main/res/drawable` and the
call button's icon in `web/app.js` use Google's Material Icons paths (Apache-2.0).

Build and test only, not in the app: Gradle and its wrapper (`android/gradle/wrapper/gradle-wrapper.jar`,
Apache-2.0), the Android Gradle plugin and Kotlin plugin (Apache-2.0), JUnit 4.13.2 (EPL-1.0), org.json
20240303 (Public Domain).

## Run beside atc, not bundled

These are installed by the user and keep their own licences: Claude Code (Anthropic's terms),
`@playwright/mcp` (Apache-2.0, through `atc browser mcp`), opencode, an OpenWA gateway, ntfy.

## Tools in the repo that fetch other work

`tools/persona/` builds a call character from a portrait. It holds scripts and JSON prompts, no model
weights, images or characters, and atc ships no character besides the orb, which is code. A character
you build with it carries the terms of what you built it with, so check them before you publish one:
LivePortrait, FLUX.2 klein through mflux, MediaPipe's landmark and segmentation models, Meta's SAM,
the `jonathandinu/face-parsing` model, LaMa and Real-ESRGAN.
