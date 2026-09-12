#!/usr/bin/env bash
# The core thread, in one command: replay across every terminal state the
# result contract distinguishes, with no model and no API key needed.
#
# Deliberately does NOT re-run discovery. That's the one step that costs a
# real API call and takes real wall-clock time against a live model - running
# it silently every time someone wants to "see the demo" would be a surprise
# charge, not a convenience. The artifact it produces, and the evidence from
# the run that produced it, are already committed:
#   artifacts/cap.member.read_savings_balance@1.0.0.json
# Re-run discovery yourself (needs ANTHROPIC_API_KEY) with:
#   npm run discover -- --goal "Look up member 12345 and read their current savings balance" \
#                       --target http://localhost:4400
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== the one real discovery run already happened; its artifact is committed =="
echo "   artifacts/cap.member.read_savings_balance@1.0.0.json"
echo "   (re-run it yourself with ANTHROPIC_API_KEY set - see README.md)"
echo

echo "== replaying across every terminal state - zero model calls, asserted not assumed =="
npx tsx scripts/gate-p5.ts

echo
echo "== full verification: npm run check    stretch demo: bash scripts/demo-stretch.sh =="
echo "== second tenant skin, generalizing live: npx tsx scripts/gate-m2.ts =="
