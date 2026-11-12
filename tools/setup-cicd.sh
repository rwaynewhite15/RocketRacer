#!/usr/bin/env bash
#
# One-time setup so GitHub Actions can deploy Rocket Racer to Cloud Run
# without any stored keys (Workload Identity Federation).
#
#   PROJECT=your-project ./tools/setup-cicd.sh
#
# Run it signed in as a project owner (`gcloud auth login`), after the first
# deploy (./deploy.sh) has created the service. Safe to re-run.
#
# What it creates:
#   - an Artifact Registry repo for the container images
#   - a "deployer" service account that may only: push images to that repo,
#     deploy new revisions of this one service, and act as the service's own
#     runtime account
#   - a Workload Identity pool + provider that trust GitHub, and ONLY this
#     repository's main branch, to act as the deployer
#
# Options (environment variables): PROJECT, REGION, SERVICE, GITHUB_REPO
# (owner/name; read from the git remote if unset), BRANCH, AR_REPO.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-rocketracer}"
AR_REPO="${AR_REPO:-rocketracer}"
BRANCH="${BRANCH:-main}"
POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-rocketracer-repo}"
DEPLOYER="${DEPLOYER:-rocketracer-deployer}"
GITHUB_REPO="${GITHUB_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##' || true)}"

if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
  echo "No project set. Run: PROJECT=your-project-id ./tools/setup-cicd.sh" >&2; exit 1
fi
if [[ ! "${GITHUB_REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Could not work out the GitHub repo. Run: GITHUB_REPO=owner/name ./tools/setup-cicd.sh" >&2; exit 1
fi
DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT}.iam.gserviceaccount.com"

echo "==> Project ${PROJECT}, region ${REGION}, service ${SERVICE}"
echo "==> Trusting GitHub repo ${GITHUB_REPO}, branch ${BRANCH}"

if ! gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" >/dev/null 2>&1; then
  echo "Cloud Run service '${SERVICE}' not found in ${REGION}. Deploy once first with ./deploy.sh" >&2; exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"

echo "==> Enabling APIs"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  artifactregistry.googleapis.com run.googleapis.com --project "${PROJECT}"

echo "==> Artifact Registry repo ${AR_REPO}"
if ! gcloud artifacts repositories describe "${AR_REPO}" --location "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location "${REGION}" \
    --description "Rocket Racer images" --project "${PROJECT}"
fi

echo "==> Deployer service account ${DEPLOYER_EMAIL}"
if ! gcloud iam service-accounts describe "${DEPLOYER_EMAIL}" --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${DEPLOYER}" --display-name "Rocket Racer deployer (GitHub Actions)" --project "${PROJECT}"
fi

echo "==> Granting it the minimum it needs"
member="serviceAccount:${DEPLOYER_EMAIL}"
gcloud run services add-iam-policy-binding "${SERVICE}" --project "${PROJECT}" --region "${REGION}" \
  --member "${member}" --role roles/run.developer --quiet >/dev/null
gcloud artifacts repositories add-iam-policy-binding "${AR_REPO}" --project "${PROJECT}" --location "${REGION}" \
  --member "${member}" --role roles/artifactregistry.writer --quiet >/dev/null
# deploying a revision "as" the service's runtime account needs permission to act as it
RUNTIME_SA="$(gcloud run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" \
  --format='value(spec.template.spec.serviceAccountName)')"
RUNTIME_SA="${RUNTIME_SA:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" --project "${PROJECT}" \
  --member "${member}" --role roles/iam.serviceAccountUser --quiet >/dev/null

echo "==> Workload Identity pool and GitHub provider"
if ! gcloud iam workload-identity-pools describe "${POOL}" --location=global --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL}" --location=global --display-name "GitHub Actions" --project "${PROJECT}"
fi
if ! gcloud iam workload-identity-pools providers describe "${PROVIDER}" --workload-identity-pool "${POOL}" \
  --location=global --project "${PROJECT}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
    --workload-identity-pool "${POOL}" --location=global --project "${PROJECT}" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${GITHUB_REPO}' && assertion.ref == 'refs/heads/${BRANCH}'"
fi
gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_EMAIL}" --project "${PROJECT}" \
  --role roles/iam.workloadIdentityUser --quiet >/dev/null \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}"

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

cat <<EOF

Done. Add these four variables to the GitHub repo
(Settings > Secrets and variables > Actions > Variables tab > New repository variable):

  GCP_PROJECT_ID  ${PROJECT}
  GCP_REGION      ${REGION}
  WIF_PROVIDER    ${WIF_PROVIDER}
  DEPLOYER_SA     ${DEPLOYER_EMAIL}

Or, with the GitHub CLI signed in:

  gh variable set GCP_PROJECT_ID --repo ${GITHUB_REPO} --body '${PROJECT}'
  gh variable set GCP_REGION     --repo ${GITHUB_REPO} --body '${REGION}'
  gh variable set WIF_PROVIDER   --repo ${GITHUB_REPO} --body '${WIF_PROVIDER}'
  gh variable set DEPLOYER_SA    --repo ${GITHUB_REPO} --body '${DEPLOYER_EMAIL}'

(Only needed if your service or image repo is not named '${SERVICE}' / '${AR_REPO}':
CLOUD_RUN_SERVICE and AR_REPO variables.)
EOF
