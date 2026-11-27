#!/bin/bash
# Publishes database.rules.json to the RTDB via the Firebase Rules REST API.
# Workaround for the firebase-tools "Failed to get instance details" failure on
# the europe-west1 instance (firebase-tools#2819): the CLI deploy path cannot
# look up this instance, but the Rules API itself works fine.
# Usage: bash publish-rules.sh   (run from anywhere; Cloud Shell has gcloud auth)
set -euo pipefail
PROJECT="rsms-a84ff"
INSTANCE="rsms-a84ff-default-rtdb"
REPO_DIR="$HOME/rsms"
RULES_FILE="database.rules.json"
API="https://firebaserules.googleapis.com/v1/projects/${PROJECT}"

cd "$REPO_DIR"
git pull origin main 2>&1 | tail -1 || true
[ -f "$RULES_FILE" ] || { echo "ERROR: $RULES_FILE not found in $REPO_DIR"; exit 1; }
python3 -c "import json;json.load(open('$RULES_FILE'))" || { echo "ERROR: $RULES_FILE is not valid JSON"; exit 1; }

T=$(gcloud auth print-access-token)
C=$(python3 -c 'import json,sys;print(json.dumps(open(sys.argv[1]).read()))' "$RULES_FILE")

echo "== compiling (test) =="
TEST=$(curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d "{\"source\":{\"files\":[{\"name\":\"database.rules.json\",\"content\":$C}]}}" "$API/rulesets:test")
echo "$TEST" | head -c 20000; echo
N_ISSUES=$(echo "$TEST" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(sum(1 for i in d.get("issues",[]) if i.get("severity")=="ERROR"))')
if [ "$N_ISSUES" != "0" ]; then echo "FAILED: $N_ISSUES compile error(s), see above"; exit 1; fi

echo "== creating ruleset =="
R=$(curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d "{\"source\":{\"files\":[{\"name\":\"database.rules.json\",\"content\":$C}]}}" "$API/rulesets")
echo "$R" | head -c 2000; echo
N=$(echo "$R" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("name",""))')
if [ -z "$N" ]; then echo "FAILED: could not create ruleset"; exit 1; fi
echo "ruleset: $N"

echo "== current release =="
curl -s -H "Authorization: Bearer $T" "$API/releases/$INSTANCE" | head -c 2000; echo

echo "== publishing =="
curl -s -X PATCH -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d "{\"ruleset_name\":\"$N\"}" "$API/releases/$INSTANCE" | head -c 2000; echo
echo "== DONE: verify at console > Realtime Database > Rules =="
