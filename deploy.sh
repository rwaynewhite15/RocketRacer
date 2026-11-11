#!/usr/bin/env bash
#
# Deploy Rocket Racer to Google Cloud Run, with Firestore for the leaderboard.
#
#   ./deploy.sh                      # uses your current gcloud project
#   PROJECT=my-project ./deploy.sh
#   REGION=europe-west1 FIRESTORE_LOCATION=eur3 ./deploy.sh
#
# Safe to re-run: every step checks before it creates. Needs the gcloud CLI,
# signed in (`gcloud auth login`) as someone who can administer the project,
# and billing enabled on the project.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-rocketracer}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
SA_NAME="${SA_NAME:-rocketracer-run}"

if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
  echo "No project set. Run: PROJECT=your-project-id ./deploy.sh" >&2
  exit 1
fi
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

echo "==> Project ${PROJECT}, region ${REGION}, service ${SERVICE}"

echo "==> Enabling APIs (Cloud Run, Cloud Build, Artifact Registry, Firestore)"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com \
  --project "${PROJECT}"

echo "==> Firestore database"
if gcloud firestore databases describe --database="(default)" --project "${PROJECT}" >/dev/null 2>&1; then
  echo "    already exists"
else
  # The location is permanent for a database, so pick it with FIRESTORE_LOCATION.
  gcloud firestore databases create --database="(default)" --location="${FIRESTORE_LOCATION}" \
    --type=firestore-native --project "${PROJECT}"
fi

echo "==> Service account ${SA_EMAIL} (may only read/write Firestore)"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" --display-name "Rocket Racer (Cloud Run)" --project "${PROJECT}"
fi
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/datastore.user --condition=None --quiet >/dev/null

echo "==> Building and deploying (Cloud Build uses the Dockerfile in this folder)"
gcloud run deploy "${SERVICE}" \
  --source . \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --service-account "${SA_EMAIL}" \
  --allow-unauthenticated \
  --set-env-vars STORE=firestore \
  --memory 256Mi --cpu 1 \
  --min-instances 0 --max-instances 3 \
  --quiet

echo
echo "==> Live at:"
gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)'
