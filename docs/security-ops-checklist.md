# Security Ops Checklist

Run this checklist on every new GCP project and then monthly.

## Credentials

- Verify there are no user-managed service-account keys:

```bash
gcloud iam service-accounts list --project "$PROJECT_ID" --format='value(email)' |
while read -r sa; do
  gcloud iam service-accounts keys list \
    --project "$PROJECT_ID" \
    --iam-account "$sa" \
    --managed-by user \
    --format='value(name.basename())'
done
```

- Delete any local JSON service-account key files under repo `.credentials/` directories.
- Use `gcloud auth login` plus `gcloud auth application-default login` for local work.
- Repoint ADC quota project when switching projects:

```bash
gcloud auth application-default set-quota-project "$PROJECT_ID"
```

## IAM

- Remove `roles/editor` from the default compute service account.
- Keep runtime access on dedicated service accounts only.
- Grant `roles/secretmanager.secretAccessor` on exact secrets, not the whole project.
- Review project IAM for unexpected human Gmail accounts:

```bash
gcloud projects get-iam-policy "$PROJECT_ID"
```

## Cloud Run

- Use a dedicated runtime service account.
- Use `--no-invoker-iam-check` if organization policy blocks `allUsers`.
- Verify deployed env vars and secret references:

```bash
gcloud run services describe agora-api --project "$PROJECT_ID" --region us-central1
```

## Storage and Redis

- Keep durable task state in a dedicated bucket with uniform bucket-level access.
- Keep Redis auth enabled and store the URL only in Secret Manager.
- Validate `/health` after every deploy.

## Release Hygiene

- Run Python lint and targeted tests before deploy.
- Run frontend build before Vercel deploy.
- Keep `.vercelignore` updated so local ledgers, virtualenvs, and build caches never ship.
