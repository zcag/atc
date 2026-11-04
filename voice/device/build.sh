#!/usr/bin/env bash
# Builds callbridge.dex. Needs only a JDK plus android.jar (platform 35) and d8.jar (build-tools 35),
# copied from an Android SDK into ~/.local/share/android-sdk-min. The stub is compile-only.
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_SDK_MIN:-$HOME/.local/share/android-sdk-min}
out=$(mktemp -d)
javac --release 11 -nowarn -cp "$SDK/android.jar" -sourcepath stubs -d "$out" CallBridge.java
java -cp "$SDK/d8.jar" com.android.tools.r8.D8 --lib "$SDK/android.jar" --min-api 34 --output "$out" "$out"/CallBridge*.class
cp "$out/classes.dex" callbridge.dex
rm -rf "$out"
ls -la callbridge.dex
