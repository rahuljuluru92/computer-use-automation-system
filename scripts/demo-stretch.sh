#!/usr/bin/env bash
# The stretch demo: approval gating + the MCP capability catalog.
#
# Deliberately separate from `scripts/demo.sh`. The core thread (discover ->
# replay -> business outcome -> recover -> fail -> escalate) is what's graded
# against Section 3; this is the optional stretch goal on top of it, and the
# plan quarantines the two so a stretch-goal slip can never break the primary
# demo path.
set -euo pipefail
cd "$(dirname "$0")/.."

ARTIFACT="artifacts/cap.member.read_savings_balance@1.0.0.json"

echo "== approving the reference capability for unattended invocation =="
npm run --silent approve -- --artifact "$ARTIFACT"

echo
echo "== an AI agent discovers and calls it over MCP =="
npx tsx scripts/demo-stretch.ts
