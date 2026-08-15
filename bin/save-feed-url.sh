#!/usr/bin/env bash
# Writes the secret Google Calendar iCal URL to disk, restrictively.
#
# Invoked by Panel.qml as a Process with stdinEnabled: true — the URL is
# written to this script's stdin, never passed as an argv, so it never
# shows up in `ps`. Usage: save-feed-url.sh <target-path>
set -euo pipefail

target="${1:?usage: save-feed-url.sh <target-path>}"
dir="$(dirname "$target")"
mkdir -p "$dir"

# umask before both mktemp and the write, so the file is created
# owner-read/write-only from the first byte, not chmod'd after the fact.
umask 077

tmp="$(mktemp "$dir/.feed-url.XXXXXX")"
IFS= read -r url
printf '%s' "$url" > "$tmp"

# Atomic within the same directory/filesystem, and `mv` here preserves the
# 600 mode mktemp created rather than any pre-existing mode on $target.
mv -f "$tmp" "$target"
