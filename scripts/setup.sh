#!/usr/bin/env bash
set -e

echo "=== FileSync Setup ==="
export IPFS_API="${IPFS_API:-http://127.0.0.1:5001/api/v0}"

npm install
npm run build

echo "Start with: npm start"
echo "Open: http://127.0.0.1:8384/ui"
