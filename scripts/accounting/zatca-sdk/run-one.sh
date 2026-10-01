#!/bin/sh
# Runs ONE documented SDK command on ONE matrix document. Inside the container this is the only
# process: no network (--network none), read-only root, read-only SDK and matrix mounts, a fresh
# tmpfs work directory, and one writable output directory. The SDK is copied to the work directory
# and installed there exactly as its readme says (install.sh), so every run starts clean.
#   run-one.sh <validate|generateHash> <documentKey>
# Environment: RUN_ID (required; written to the output so the harness can reject foreign output),
# SDK_DIR (extracted archive, read-only), IN_DIR (matrix, read-only), OUT_DIR (this command's own new,
# empty output directory), WORK_DIR (scratch).
# Exit status: 0 = the SDK command was executed and its own exit code is in $OUT_DIR/exit (which may
# be nonzero); anything else = the runner stopped before or instead of running it, with the reason in
# $OUT_DIR/runner-error. The harness treats every nonzero exit as a FAIL.
set -u
CMD=${1:-}; KEY=${2:-}
SDK_DIR=${SDK_DIR:-/sdk}; IN_DIR=${IN_DIR:-/in}; OUT_DIR=${OUT_DIR:-/out}; WORK_DIR=${WORK_DIR:-/work}
O=$OUT_DIR
fail() { echo "$2" > "$O/runner-error" 2>/dev/null; echo "run-one: $2" >&2; exit "$1"; }
case "$CMD" in validate|generateHash) ;; *) echo "run-one: unknown command '$CMD'" >&2; exit 64;; esac
[ -n "${RUN_ID:-}" ] || { echo "run-one: RUN_ID not set" >&2; exit 64; }
[ -d "$O" ] || { echo "run-one: output directory $O missing" >&2; exit 65; }
[ -z "$(ls -A "$O")" ] || { echo "run-one: output directory is not empty (refusing to mix runs)" >&2; exit 66; }
printf '%s\n' "$RUN_ID" > "$O/run-id" || exit 66
DOC="$IN_DIR/$KEY/document.xml"
[ -f "$DOC" ] || fail 67 "input document missing: $KEY/document.xml"
sha256sum "$DOC" | cut -d' ' -f1 > "$O/input.sha256" || fail 68 "could not checksum the input"
W="$WORK_DIR/$KEY-$CMD"
{ rm -rf "$W" && mkdir -p "$W/home"; } || fail 69 "could not create the work directory"
ROOT_REL=$(cat "$SDK_DIR/.sdk-root" 2>/dev/null) || fail 69 "SDK root marker missing"
cp -R "$SDK_DIR/$ROOT_REL/." "$W/sdk" || fail 70 "copying the SDK to the work directory failed"
export HOME="$W/home"
java -version > "$O/java-version" 2>&1 || fail 71 "java is not runnable"
# Installation exactly as the readme says. Any failure stops here: nothing runs on a half-installed SDK.
( cd "$W/sdk" && sh install.sh ) > "$O/install.log" 2>&1
rc=$?; echo "$rc" > "$O/install.exit"
[ "$rc" -eq 0 ] || fail 72 "SDK installation failed (install.sh exit $rc; see install.log)"
PROFILE="$HOME/.bash-profile"; [ -f "$PROFILE" ] || PROFILE="$HOME/.bash_profile"
[ -f "$PROFILE" ] || fail 73 "install.sh wrote no profile (~/.bash-profile or ~/.bash_profile)"
. "$PROFILE" || fail 73 "the profile written by install.sh could not be loaded"
[ -n "${FATOORA_HOME:-}" ] || fail 74 "install.sh did not define FATOORA_HOME"
[ -f "$FATOORA_HOME/fatoora" ] || fail 75 "fatoora launcher not found in FATOORA_HOME"
chmod +x "$FATOORA_HOME/fatoora" 2>/dev/null || true
date -u +%FT%TZ > "$O/started"
printf '%s\n' "fatoora" "-$CMD" "-invoice" "$DOC" > "$O/argv"
( cd "$FATOORA_HOME" && ./fatoora "-$CMD" -invoice "$DOC" ) > "$O/stdout" 2> "$O/stderr"
echo $? > "$O/exit"
date -u +%FT%TZ > "$O/finished"
exit 0
