#!/bin/bash
# Double-click to start the Task Pilot server on a Mac.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install the LTS version from https://nodejs.org, then double-click this file again."
  open https://nodejs.org
  read -r -p "Press Return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing Task Pilot - first run only, this takes a minute..."
  if ! npm install --omit=dev; then
    read -r -p "Install failed. Check your internet connection and try again. Press Return to close."
    exit 1
  fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created your settings file. It is opening in TextEdit now."
  echo "Fill it in, save it, close TextEdit, then double-click this file again."
  open -e .env
  exit 0
fi

echo
echo "Starting Task Pilot. Keep this window open - you can minimise it."
echo "Closing this window stops the server."
echo
# caffeinate keeps the Mac from sleeping while the server runs.
caffeinate -is npm start
