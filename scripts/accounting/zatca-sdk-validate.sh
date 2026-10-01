#!/usr/bin/env bash
# Validate the application's six-document matrix (scripts/accounting/zatca-matrix.sh) with ZATCA's
# OFFICIAL e-invoicing SDK. Nothing is sent anywhere; the SDK runs offline.
#
#   SDK_ARCHIVE=/path/to/official-sdk.zip SDK_SHA256=<sha-256 recorded when it was downloaded from
#   zatca.gov.sa> SDK_SOURCE_URL=<the zatca.gov.sa URL it came from> \
#     bash scripts/accounting/zatca-sdk-validate.sh <matrixDir> <outDir>
#
# Guards, in order (any failure stops the run; nothing is guessed):
#  1. the archive's SHA-256 must equal SDK_SHA256, and SDK_SOURCE_URL must be a zatca.gov.sa URL —
#     a copy from anywhere else (e.g. a GitHub repository) is not the official SDK;
#  2. the archive is extracted into <outDir>/sdk; installation follows the archive's own readme
#     (install.sh, then FATOORA_HOME / SDK_CONFIG from the profile it writes) inside an isolated
#     HOME under <outDir>, so nothing outside <outDir> changes;
#  3. Java must satisfy the readme's stated range (the readme in the copies seen says >=11 and <15):
#     JAVA_HOME defaults to the Ubuntu openjdk-11 runtime;
#  4. each command is run only if its exact syntax appears in the extracted readme:
#       fatoora -validate -invoice <file>        (validation)
#       fatoora -generateHash -invoice <file>    (the SDK's hash, compared with ours)
#     The full raw output of every command is kept; the summary only quotes lines the SDK printed.
#  The SDK's default certificate and private key are left as shipped (its documented test material);
#  none is created or edited here. Our documents are signed with our own LOCAL test key, not with a
#  XAdES signature, so signature-related checks are expected to fail until that is implemented.
set -euo pipefail
MATRIX=${1:?matrix dir}; OUT=${2:?out dir}
: "${SDK_ARCHIVE:?set SDK_ARCHIVE to the official SDK zip}"; : "${SDK_SHA256:?set SDK_SHA256 (from the download record)}"; : "${SDK_SOURCE_URL:?set SDK_SOURCE_URL (zatca.gov.sa)}"
case "$SDK_SOURCE_URL" in https://zatca.gov.sa/*|https://www.zatca.gov.sa/*|https://sandbox.zatca.gov.sa/*) ;; *) echo "Refusing: SDK_SOURCE_URL is not a zatca.gov.sa URL"; exit 2;; esac
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd); MATRIX=$(cd "$MATRIX" && pwd)
LOG="$OUT/provenance.txt"
actual=$(sha256sum "$SDK_ARCHIVE" | cut -d' ' -f1)
{ echo "archive: $(basename "$SDK_ARCHIVE")"; echo "source URL: $SDK_SOURCE_URL"; echo "sha256 expected: $SDK_SHA256"; echo "sha256 actual:   $actual"; echo "checked: $(date -u +%FT%TZ)"; } > "$LOG"
[ "$actual" = "$SDK_SHA256" ] || { echo "Refusing: archive SHA-256 does not match SDK_SHA256" | tee -a "$LOG"; exit 3; }

rm -rf "$OUT/sdk" "$OUT/home"; mkdir -p "$OUT/sdk" "$OUT/home"
unzip -q "$SDK_ARCHIVE" -d "$OUT/sdk"
ROOT=$(dirname "$(find "$OUT/sdk" -name install.sh -print -quit)")
[ -n "$ROOT" ] && [ -f "$ROOT/install.sh" ] || { echo "Refusing: no install.sh in the archive" | tee -a "$LOG"; exit 4; }
README=$(find "$ROOT" -iname 'readme.md' -print -quit); [ -n "$README" ] || README=$(find "$ROOT" -iname 'readme*' -print -quit)
JAR=$(find "$ROOT/Apps" -name '*.jar' -print -quit)
{ echo "sdk root: ${ROOT#$OUT/}"; echo "jar: $(basename "$JAR")  sha256 $(sha256sum "$JAR" | cut -d' ' -f1)"; echo "readme: ${README#$OUT/}"
  echo "readme Java requirement lines:"; grep -n -i "java.*version\|>=11\|between 11" "$README" | head -5 || true; } >> "$LOG"

export JAVA_HOME=${JAVA_HOME_SDK:-/usr/lib/jvm/java-11-openjdk-amd64}
export PATH="$JAVA_HOME/bin:$PATH"
jv=$("$JAVA_HOME/bin/java" -version 2>&1 | grep -v JAVA_TOOL | head -1)
echo "java: $jv" >> "$LOG"
major=$(echo "$jv" | sed -E 's/.*"([0-9]+)[."].*/\1/')
{ [ "$major" -ge 11 ] && [ "$major" -lt 15 ]; } || { echo "Refusing: Java $major is outside 11..14" | tee -a "$LOG"; exit 5; }

for syntax in "fatoora -validate -invoice" "fatoora -generateHash -invoice"; do
  grep -qF "$syntax" "$README" || grep -qF "$(echo "$syntax" | sed 's/ / \\*\\*\\*/')" "$README" || { tr -d '*\\' < "$README" | grep -qF "$syntax"; } || { echo "Refusing: '$syntax' is not documented in the archive's readme" | tee -a "$LOG"; exit 6; }
done

# Install as the readme says, inside an isolated HOME.
( export HOME="$OUT/home"; cd "$ROOT" && sh install.sh ) > "$OUT/install.log" 2>&1 || { echo "install.sh failed (see install.log)" | tee -a "$LOG"; exit 7; }
PROFILE="$OUT/home/.bash-profile"; [ -f "$PROFILE" ] || PROFILE="$OUT/home/.bash_profile"
set +u; export HOME="$OUT/home"; . "$PROFILE"; set -u
[ -n "${FATOORA_HOME:-}" ] && [ -n "${SDK_CONFIG:-}" ] || { echo "install.sh did not define FATOORA_HOME/SDK_CONFIG" | tee -a "$LOG"; exit 8; }
chmod +x "$FATOORA_HOME/fatoora" 2>/dev/null || true
echo "FATOORA_HOME=${FATOORA_HOME#$OUT/}  SDK_CONFIG=${SDK_CONFIG#$OUT/}" >> "$LOG"

SUMMARY="$OUT/SUMMARY.md"
{ echo "# Official SDK run on the application matrix"; echo; echo "Matrix: \`$(jq -r .commit "$MATRIX/MANIFEST.json")\` fixture \`$(jq -r .fixture "$MATRIX/MANIFEST.json")\`; SDK: \`$(basename "$JAR")\`"; echo; } > "$SUMMARY"
for dir in "$MATRIX"/*/; do
  key=$(basename "$dir"); f="$dir/document.xml"; [ -f "$f" ] || continue
  mkdir -p "$OUT/$key"
  for cmd in validate generateHash; do
    set +e; ( cd "$FATOORA_HOME" && ./fatoora -$cmd -invoice "$f" ) > "$OUT/$key/$cmd.out" 2>&1; rc=$?; set -e
    echo "$rc" > "$OUT/$key/$cmd.rc"
  done
  ours=$(jq -r .invoiceHash "$dir/meta.json")
  { echo "## $key"; echo; echo "- command: \`fatoora -validate -invoice $key/document.xml\` → exit $(cat "$OUT/$key/validate.rc")"
    echo "- XML sha256: \`$(sha256sum "$f" | cut -d' ' -f1)\`"
    echo "- lines printed by the SDK that mention a result (verbatim):"; echo '```'; grep -i -E "result|passed|failed|error|warning" "$OUT/$key/validate.out" | head -60 || echo "(none)"; echo '```'
    echo "- \`fatoora -generateHash\` → exit $(cat "$OUT/$key/generateHash.rc"); our hash \`$ours\`; SDK output contains our hash: $(grep -qF "$ours" "$OUT/$key/generateHash.out" && echo yes || echo NO)"; echo; } >> "$SUMMARY"
done
for f in "$OUT"/*/*.out "$OUT"/install.log; do sed -i -E 's#postgres(ql)?://[^ "]+#postgres://***#g' "$f"; done
echo "done: $SUMMARY"
