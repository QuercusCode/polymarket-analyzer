#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

# Create venv if needed
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment…"
  python3 -m venv .venv
fi

source .venv/bin/activate

# Install / upgrade deps
pip install -q -r requirements.txt

echo ""
echo "  Polymarket Analyzer"
echo "  Dashboard → http://localhost:8000"
echo "  API docs  → http://localhost:8000/docs"
echo ""

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
