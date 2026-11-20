#!/bin/bash
# Deploy RSMS Cloud Functions (created by Fo, Nov 20 2026)
set -e
cd ~/rsms
firebase deploy --only functions --project rsms-a84ff
