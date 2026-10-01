#!/usr/bin/env bash
# SECONDARY developer check of the six-document matrix — NOT official ZATCA validation.
#   1. XML Schema validation against the UBL 2.1 Invoice schema (xmllint);
#   2. the EN 16931 and ZATCA business-rule files (compiled Schematron, XSLT 2.0) run with Saxon-HE
#      in the runner container with no network, read-only inputs and an unprivileged user.
# The schema and rule files come from whatever SDK copy is given in <dataDir> (its Data/ folder).
# Until the official SDK is obtained, the only copy available is a THIRD-PARTY redistribution whose
# provenance cannot be verified; every file's SHA-256 is recorded so the run can be compared with the
# official files later. Saxon-HE and xmlresolver come from Maven Central (checksums recorded).
#
#   bash scripts/accounting/zatca-secondary-check.sh <matrixDir> <sdkDataDir> <toolsDir> <outDir>
# Exit: 0 if no schema error and no rule with flag="error" fired; 1 otherwise. Warnings are reported.
set -uo pipefail
M=$(cd "${1:?matrix}" && pwd); D=$(cd "${2:?sdk Data dir}" && pwd); T=$(cd "${3:?tools dir}" && pwd); OUT=${4:?out}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd); chmod 777 "$OUT"
XSD="$D/Schemas/xsds/UBL2.1/xsd/maindoc/UBL-Invoice-2.1.xsd"
RULES=$(ls "$D/Rules/Schematrons/"*.xsl)
IMAGE=${IMAGE:-zatca-sdk-runner:11}
{ echo "# Secondary check — NOT official ZATCA validation"; echo "date: $(date -u +%FT%TZ)"; echo "matrix: $M"; echo "matrix commit: $(jq -r .commit "$M/MANIFEST.json")"
  echo "schema: $(sha256sum "$XSD" | cut -d' ' -f1)  ${XSD#$D/}"; for r in $RULES; do echo "rules:  $(sha256sum "$r" | cut -d' ' -f1)  ${r#$D/}"; done
  for j in "$T"/*.jar; do echo "tool:   $(sha256sum "$j" | cut -d' ' -f1)  $(basename "$j")"; done; echo "image:  $IMAGE $(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null)"; } > "$OUT/provenance.txt"
rc=0
echo '{"documents":[' > "$OUT/summary.json"; first=1
for k in standard-invoice standard-credit-note standard-debit-note simplified-invoice simplified-credit-note simplified-debit-note; do
  f="$M/$k/document.xml"
  xmllint --noout --schema "$XSD" "$f" > "$OUT/$k.xsd.txt" 2>&1; xsd=$?
  [ $xsd -eq 0 ] || rc=1
  asserts="[]"
  for r in $RULES; do
    n=$(basename "$r" .xsl)
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -v "$T":/tools:ro -v "$D/Rules/Schematrons":/rules:ro -v "$M":/in:ro -v "$OUT":/out \
      "$IMAGE" java -cp /tools/Saxon-HE-12.5.jar:/tools/xmlresolver-5.2.2.jar net.sf.saxon.Transform -s:/in/$k/document.xml -xsl:/rules/$n.xsl -o:/out/$k.$n.svrl > "$OUT/$k.$n.log" 2>&1 || rc=1
    a=$(python3 - "$OUT/$k.$n.svrl" "$n" <<'EOF'
import sys,re,html,json
try: t=open(sys.argv[1],encoding='utf-8').read()
except Exception as e: print(json.dumps([{"rules":sys.argv[2],"id":"RUN-FAILED","flag":"error","text":str(e)}])); sys.exit()
out=[]
for m in re.finditer(r'<svrl:failed-assert(.*?)</svrl:failed-assert>',t,re.S):
    a=m.group(1); g=lambda k: (re.search(k+r'="([^"]*)"',a) or [None,None])[1]
    out.append({"rules":sys.argv[2],"id":g("id"),"flag":g("flag"),"location":g("location"),"text":re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',a.split('>',1)[1]))).strip()[:400]})
print(json.dumps(out,ensure_ascii=False))
EOF
)
    asserts=$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])+json.loads(sys.argv[2]),ensure_ascii=False))' "$asserts" "$a")
  done
  errors=$(python3 -c 'import json,sys; print(sum(1 for x in json.loads(sys.argv[1]) if x["flag"]!="warning"))' "$asserts")
  [ "$errors" = "0" ] || rc=1
  [ $first -eq 1 ] || echo "," >> "$OUT/summary.json"; first=0
  python3 -c 'import json,sys; print(json.dumps({"key":sys.argv[1],"xsdValid":sys.argv[2]=="0","xsdErrors":open(sys.argv[3]).read().strip().splitlines() if sys.argv[2]!="0" else [],"failedAsserts":json.loads(sys.argv[4])},ensure_ascii=False))' "$k" "$xsd" "$OUT/$k.xsd.txt" "$asserts" >> "$OUT/summary.json"
  echo "$k: XSD $([ $xsd -eq 0 ] && echo valid || echo INVALID); rule errors $errors; warnings $(python3 -c 'import json,sys; print(sum(1 for x in json.loads(sys.argv[1]) if x["flag"]=="warning"))' "$asserts") $(python3 -c 'import json,sys; print(sorted({x["id"] for x in json.loads(sys.argv[1])}))' "$asserts")"
done
echo ']}' >> "$OUT/summary.json"
exit $rc
