#!/bin/bash
# Publishes database.rules.json to the Realtime Database via the RTDB REST API.
# The firebaserules.googleapis.com rulesets API parses source as the Firestore
# rules language and rejects RTDB JSON ("does not compile"); RTDB rules go
# through the database's own .settings/rules.json endpoint. The firebase-tools
# CLI deploy path is broken for this europe-west1 instance (firebase-tools#2819:
# "Failed to get instance details"), which is why the REST endpoint is used.
# Usage: bash publish-rules.sh   (run from anywhere; Cloud Shell has gcloud auth)
set -euo pipefail
PROJECT="rsms-a84ff"
INSTANCE="rsms-a84ff-default-rtdb"
REPO_DIR="$HOME/rsms"
RULES_FILE="database.rules.json"
HOST="https://${INSTANCE}.europe-west1.firebasedatabase.app"

cd "$REPO_DIR"
git pull origin main 2>&1 | tail -1 || true
[ -f "$RULES_FILE" ] || { echo "ERROR: $RULES_FILE not found in $REPO_DIR"; exit 1; }
python3 -c "import json;json.load(open('$RULES_FILE'))" || { echo "ERROR: $RULES_FILE is not valid JSON"; exit 1; }

T=$(gcloud auth print-access-token)

echo "== publishing =="
R=$(curl -s -X PUT -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @"$RULES_FILE" "$HOST/.settings/rules.json")
case "$R" in
  *'"error"'*) echo "FAILED:"; echo "$R" | head -c 2000; echo; exit 1;;
esac
echo "$R" | head -c 400; echo " ..."

echo "== verify =="
curl -s -H "Authorization: Bearer $T" "$HOST/.settings/rules.json" > /tmp/live-rules.json
python3 - "$RULES_FILE" <<'PYEOF'
import json, sys
local = json.load(open(sys.argv[1]))
live = json.load(open("/tmp/live-rules.json"))
if local == live:
    print("VERIFIED: live rules match the repo file exactly")
else:
    print("MISMATCH: live rules differ from the repo file")
PYEOF
echo "== DONE =="
