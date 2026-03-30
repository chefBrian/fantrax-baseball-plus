#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
DIST=dist

echo "Building FantraxBaseball+ v${VERSION}..."
rm -rf "$DIST"

# --- Chrome ---
mkdir -p "$DIST/chrome/icons"
sed "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src/chrome/manifest.json > "$DIST/chrome/manifest.json"
cp src/chrome/rules.json "$DIST/chrome/"
cp src/background.js "$DIST/chrome/"
cp src/shared/content.js "$DIST/chrome/"
cp src/shared/content.css "$DIST/chrome/"
cp src/shared/popup.html "$DIST/chrome/"
cp src/shared/popup.js "$DIST/chrome/"
cp src/shared/icons/icon-16.png "$DIST/chrome/icons/"
cp src/shared/icons/icon-48.png "$DIST/chrome/icons/"
cp src/shared/icons/icon-128.png "$DIST/chrome/icons/"
cd "$DIST/chrome"
zip -r "../fantrax-baseball-plus-chrome-v${VERSION}.zip" .
cd ../..
echo "  -> dist/fantrax-baseball-plus-chrome-v${VERSION}.zip"

# --- Firefox ---
mkdir -p "$DIST/firefox/icons"
sed "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" src/firefox/manifest.json > "$DIST/firefox/manifest.json"
cp src/chrome/rules.json "$DIST/firefox/"
cp src/background.js "$DIST/firefox/"
cp src/shared/content.js "$DIST/firefox/"
cp src/shared/content.css "$DIST/firefox/"
cp src/shared/popup.html "$DIST/firefox/"
cp src/shared/popup.js "$DIST/firefox/"
cp src/shared/icons/icon-48.png "$DIST/firefox/icons/"
cp src/shared/icons/icon-96.png "$DIST/firefox/icons/"
cd "$DIST/firefox"
zip -r "../fantrax-baseball-plus-firefox-v${VERSION}.zip" .
cd ../..
echo "  -> dist/fantrax-baseball-plus-firefox-v${VERSION}.zip"

echo "Done!"
