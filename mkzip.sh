#!/bin/bash
# Build a distribution zip for Decky Loader
set -e

PLUGIN_NAME="decky-video-uploader"
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

mkdir "$STAGING/$PLUGIN_NAME"
cp -r dist assets main.py package.json plugin.json LICENSE README.md "$STAGING/$PLUGIN_NAME/"

rm -f "$PLUGIN_NAME.zip"
(cd "$STAGING" && zip -r "$OLDPWD/$PLUGIN_NAME.zip" "$PLUGIN_NAME/")

echo "Created $PLUGIN_NAME.zip"
