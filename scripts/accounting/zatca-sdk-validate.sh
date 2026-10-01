#!/usr/bin/env bash
# Kept for continuity: the harness is now scripts/accounting/zatca-sdk/harness.mjs (evidence and gate
# separated; container isolation; exit 0 only if every required check is PASS). Arguments are passed
# through unchanged — see that file's header and docs/accounting/ZATCA_SDK_VALIDATION.md.
exec node "$(dirname "$0")/zatca-sdk/harness.mjs" "$@"
