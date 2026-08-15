#!/usr/bin/env bash
# Fetches the secret Google Calendar iCal feed without passing the URL
# as a command-line argument, keeping the bearer secret out of `ps`.
#
# Reads the URL from <feed-url-path> (or stdin if "-" is passed) and feeds
# it to curl via --config - on stdin.
# Usage: fetch-feed.sh <feed-url-path>
set -euo pipefail

target="${1:?usage: fetch-feed.sh <feed-url-path>}"

if [[ "$target" == "-" ]]; then
  IFS= read -r url || true
else
  if [[ ! -r "$target" ]]; then
    exit 1
  fi
  IFS= read -r url < "$target" || true
fi

url="$(printf '%s' "$url" | tr -d '\r\n')"
if [[ -z "$url" ]]; then
  exit 1
fi

# Escape backslashes and double quotes for curl's config file format
escaped_url="${url//\\/\\\\}"
escaped_url="${escaped_url//\"/\\\"}"

printf 'url = "%s"\n' "$escaped_url" | curl -fsS --max-time 10 --config -
