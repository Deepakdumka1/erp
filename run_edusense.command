#!/bin/bash
# Double-click to start EduSense AI on this Mac. Close this window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
PORT=5050
echo "== EduSense AI =="
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Install it from https://www.python.org/downloads/ and try again."; read -r -p "Press Enter to close."; exit 1
fi
if [ ! -d .venv ]; then
  echo "Creating a local Python environment (.venv)…"
  python3 -m venv .venv || { read -r -p "Could not create .venv. Press Enter to close."; exit 1; }
fi
source .venv/bin/activate
echo "Installing requirements (first run only takes a minute)…"
python -m pip install --quiet --disable-pip-version-check -r requirements.txt || { read -r -p "Install failed. Check your internet connection, then press Enter to close."; exit 1; }
echo "Starting EduSense AI at http://127.0.0.1:$PORT/login"
( sleep 3; open "http://127.0.0.1:$PORT/login" ) &
PORT=$PORT python app.py
