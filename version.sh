#!/bin/bash
set -e

# Usage: ./version.sh [major|minor|patch]
# Bumps version in package.json and both manifests, then creates a git tag.

BUMP=${1:-patch}
CURRENT=$(node -p "require('./package.json').version")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [major|minor|patch]"; exit 1 ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

# Update all version sources
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW\"/" package.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW\"/" src/chrome/manifest.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW\"/" src/firefox/manifest.json

echo "Bumped $CURRENT -> $NEW"
echo ""
echo "Next steps:"
echo "  git add -A && git commit -m \"v$NEW\""
echo "  git tag v$NEW"
echo "  git push origin main --tags"
