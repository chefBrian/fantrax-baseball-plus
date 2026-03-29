#!/bin/bash
set -e

VERSION=$(grep '"version"' src/chrome/manifest.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
DIST=dist

echo "Building FantraxBaseball+ v${VERSION}..."
rm -rf "$DIST"

# --- Chrome ---
mkdir -p "$DIST/chrome/icons"
cp src/chrome/manifest.json "$DIST/chrome/"
cp src/chrome/rules.json "$DIST/chrome/"
cp src/background.js "$DIST/chrome/"
cp src/shared/content.js "$DIST/chrome/"
cp src/shared/content.css "$DIST/chrome/"
cp src/shared/icons/icon-16.png "$DIST/chrome/icons/"
cp src/shared/icons/icon-48.png "$DIST/chrome/icons/"
cp src/shared/icons/icon-128.png "$DIST/chrome/icons/"
cd "$DIST/chrome"
zip -r "../fantrax-baseball-plus-chrome-v${VERSION}.zip" .
cd ../..
echo "  -> dist/fantrax-baseball-plus-chrome-v${VERSION}.zip"

# --- Firefox ---
mkdir -p "$DIST/firefox/icons"
cp src/firefox/manifest.json "$DIST/firefox/"
cp src/chrome/rules.json "$DIST/firefox/"
cp src/background.js "$DIST/firefox/"
cp src/shared/content.js "$DIST/firefox/"
cp src/shared/content.css "$DIST/firefox/"
cp src/shared/icons/icon-48.png "$DIST/firefox/icons/"
cp src/shared/icons/icon-96.png "$DIST/firefox/icons/"
cd "$DIST/firefox"
zip -r "../fantrax-baseball-plus-firefox-v${VERSION}.zip" .
cd ../..
echo "  -> dist/fantrax-baseball-plus-firefox-v${VERSION}.zip"

echo "Done!"
