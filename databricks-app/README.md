# Databricks App snapshot: `instagram-risk-analyzer`

A copy of the Databricks App that Genie maintains in the Databricks workspace. **This folder is a backup, not the source of truth**: editing these files changes nothing until someone deploys them in Databricks.

- Snapshot of deployment `01f1e0b30e7e1eabb94e4d52d7fef105`, the last known-good version (2026-11-14).
- Checks that passed against it: `npm run check:databricks` and `npm run check:history` (see `docs/TEST_RESULTS.md`).
- Files: `app.py` (FastAPI relay + history endpoints), `app.yaml` (start command), `requirements.txt`.
- The workspace copy had a leading `%python` line (a notebook marker). It is left out here because `python app.py` would fail on it.

## If a new deployment breaks things

1. In Databricks, open the app's **Deployments** tab and roll back to `01f1e0b30e7e1eabb94e4d52d7fef105`.
2. If that deployment is gone, redeploy these three files.
3. Run `npm run check:databricks` and `npm run check:history` in `backend/` to confirm.

Rolling back restores code only. Tables, grants and stored rows are not rolled back.

What the app must provide is specified in `docs/DATABRICKS_APP_API.md`.
