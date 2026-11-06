# Configurable assessment schemes

## Supported schemes

Schools choose one of two formats in **Admin → Settings → Assessment Scheme**:

- `T1 + T2 + Exam`
- `T1 + T2 + T3 + Exam`

Each component has its own whole-number maximum from 1 to 1000. In the two-test format the unused T3 maximum is stored as `0`. The shared model is `rsms-assessment.js`; the legacy default remains `{tests:2, ca1:20, ca2:20, ca3:0, exam:60}`.

## What is stored

The current school scheme is stored at:

```text
schools/<schoolId>/info/assessment
```

Saving it writes **only that leaf**. It does not rewrite students, score entries, published results, or unrelated school settings.

Every new or edited score record also stores a copy of the scheme that was used for that record:

```json
{
  "stuId": "…",
  "subject": "Mathematics",
  "class": "JSS 1",
  "term": "First Term",
  "session": "2025/2026",
  "ca1": 10,
  "ca2": 15,
  "ca3": 20,
  "exam": 40,
  "total": 85,
  "assessment": { "tests": 3, "ca1": 10, "ca2": 15, "ca3": 20, "exam": 55 }
}
```

Historical records without a snapshot are interpreted as the legacy `20 + 20 + 60` scheme. They are not migrated or rewritten. Changing the school scheme affects future entry and unsaved drafts only; existing records keep their original denominators. Overrides validate against the record’s saved scheme, not the school’s current scheme.

Percentages are `raw total / saved maximum × 100`. Mixed-scheme class summaries and cumulative reports sum raw marks and denominators separately; they do not average percentages as if every record were out of 100.

## Connected paths

- Admin settings, admin score entry, teacher entry, class-teacher entry, and principal overrides use `RSMSAssessment`.
- Teacher CSV templates/import include `CA 3` only when the selected scheme has three tests. Import validates maxima, context, subjects, duplicates, and blocks silently replacing an older saved scheme with the current one.
- Principal results/analytics, terminal report cards, student results, parent results, and the analytics scores tab read the saved record snapshots.
- Unchanged rows are skipped by admin/class-teacher bulk saves so an unrelated override does not rewrite historical rows.
- Published-result locks still block teacher/admin/class-teacher saves. Principal overrides retain their existing post-publication capability and require a reason.

## Tests and deployment checks

```bash
npm ci
npm test
npm run test:workflow
npm run test:dom-checks
npm run check:syntax
npm ci --prefix offline
npm test --prefix offline
```

The workflow tests execute the real local portal scripts in jsdom with an in-memory Firebase double. They cover settings changes, mixed historical/new records, CSV import, teacher/class-teacher/admin/principal overrides, report/student/parent rendering, cumulative denominators, published locks, failed settings writes, and the read-only roster backup diagnostic.

Deploy the changed root portal files and `sw.js` with the normal static-site process. The service-worker cache name changes to `rsms-v3.2.0-assessment` so clients fetch the updated pages/scripts. No score-data migration or Firebase rules deployment is required for this change; the existing `info` write rule already restricts school settings writes to authorized admins/superadmins.

Before live rollout, smoke-test a disposable school in a real browser: save each scheme, enter/import scores, change the scheme again, confirm old records keep their old maxima, print a report, and check student/parent views. jsdom does not verify real print layout, browser audio, or live Firebase permissions.

## Read-only investigation: `REH-2J8KQ2XF` student count

The reported symptom is an admin dashboard count of 2 while Firebase was believed to contain at least 18. No live backup for that school was available in this workspace, so the actual count discrepancy has **not** been verified and no student records were changed.

Safe procedure:

1. Sign in as an admin for `REH-2J8KQ2XF` while online.
2. On the dashboard, run **Check student count**. It reads `schools/REH-2J8KQ2XF/students` once and compares it with the local cache; it performs no writes.
3. Before attempting any repair, click **Download read-only roster backup**. The JSON contains the school ID, database path, dashboard count, raw local/database rosters, and a diagnosis. Store it outside the public site.
4. Analyse it locally:

   ```bash
   node tools/roster-backup-check.js path/to/backup.json
   node tools/roster-backup-check.js path/to/backup.json --json
   ```

The checker reports raw entries, valid/invalid records, duplicate IDs, database IDs missing from the cache, and cache-only IDs. Exit code `0` means counts/IDs match; `1` means a mismatch was found; `2` means the file could not be analysed. It never contacts Firebase and never rewrites the backup.

A mismatch can indicate a stale/incomplete cache, invalid records, duplicate IDs, or the wrong school context. It is not proof of deletion. Do not “fix” the count by importing, overwriting, or deleting student records; reconcile only after reviewing the backup with the school.

## Known limitations

- Legacy records predating snapshots are assumed to use `20/20/60`; if a school historically used different maxima without storing them, those maxima cannot be inferred automatically.
- Corrupt/ambiguous saved schemes are surfaced as invalid/incomplete rather than guessed or auto-repaired.
- `RSMS_FB.saveScores` reports local acceptance/queueing, not a per-record cloud acknowledgement; settings saves do wait for the Firebase leaf acknowledgement.
- The offline LAN appliance still serves the updated pages and syncs `score_entries` payloads, but a dedicated offline/cloud sync path for `info/assessment` was not added. Treat assessment-scheme changes as a cloud-portal feature until the appliance sync is extended and tested.
- The real `REH-2J8KQ2XF` roster still needs the backup-based investigation above.
