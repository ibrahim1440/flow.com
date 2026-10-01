#!/bin/sh
# Runs ONE documented SDK command on ONE matrix document. Inside the container this is the only
# process: no network (--network none), read-only root, read-only SDK and matrix mounts, a fresh
# tmpfs work directory, and one writable output directory. The SDK is copied to the work directory
# and installed there exactly as its readme says (install.sh), so every run starts clean.
#   run-one.sh <validate|generateHash> <documentKey>
# Paths (defaults are the container mounts): SDK_DIR (extracted archive, read-only), IN_DIR (matrix,
# read-only), OUT_DIR (writable), WORK_DIR (scratch).
set -u
CMD=$1; KEY=$2
SDK_DIR=${SDK_DIR:-/sdk}; IN_DIR=${IN_DIR:-/in}; OUT_DIR=${OUT_DIR:-/out}; WORK_DIR=${WORK_DIR:-/work}
case "$CMD" in validate|generateHash) ;; *) echo "unknown command $CMD" >&2; exit 64;; esac
O="$OUT_DIR/$KEY"; mkdir -p "$O"
W="$WORK_DIR/$KEY-$CMD"; rm -rf "$W"; mkdir -p "$W/home"
ROOT_REL=$(cat "$SDK_DIR/.sdk-root" 2>/dev/null || echo .)
cp -R "$SDK_DIR/$ROOT_REL/." "$W/sdk"
export HOME="$W/home"
java -version > "$O/$CMD.java-version" 2>&1
( cd "$W/sdk" && sh install.sh ) > "$O/$CMD.install.log" 2>&1
PROFILE="$HOME/.bash-profile"; [ -f "$PROFILE" ] || PROFILE="$HOME/.bash_profile"
[ -f "$PROFILE" ] && . "$PROFILE"
if [ -z "${FATOORA_HOME:-}" ]; then echo "install.sh did not define FATOORA_HOME" > "$O/$CMD.stderr"; echo 70 > "$O/$CMD.exit"; exit 0; fi
chmod +x "$FATOORA_HOME/fatoora" 2>/dev/null || true
date -u +%FT%TZ > "$O/$CMD.started"
printf '%s\n' "fatoora" "-$CMD" "-invoice" "$IN_DIR/$KEY/document.xml" > "$O/$CMD.argv"
( cd "$FATOORA_HOME" && ./fatoora "-$CMD" -invoice "$IN_DIR/$KEY/document.xml" ) > "$O/$CMD.stdout" 2> "$O/$CMD.stderr"
echo $? > "$O/$CMD.exit"
date -u +%FT%TZ > "$O/$CMD.finished"
exit 0
