#!/usr/bin/env bash
#
# One-time setup for the release pipeline (.github/workflows/ci-cd.yml):
# a staging copy of the game, and keyless deploy access for GitHub Actions.
#
#   PROJECT=your-project ./tools/setup-cicd.sh
#
# Run it signed in as a project owner (`gcloud auth login`), after the first
# ./deploy.sh has created the production service. Safe to re-run.
#
# What it creates:
#   - the staging service (rocketracer-staging): same project, own URL, own
#     leaderboard collection, built from the code in this checkout
#   - an Artifact Registry repo for the pipeline's container images
#   - two deploy accounts GitHub Actions can act as, with no stored keys
#     (Workload Identity Federation):
#       production deployer   only from this repo's main branch;
#                             can only roll out new revisions of production
#       staging deployer      from any branch of this repo;
#                             can only push images and roll out staging
#
# Options (environment variables): PROJECT, REGION, SERVICE, STAGING_SERVICE,
# GITHUB_REPO (owner/name; read from the git remote if unset), BRANCH, AR_REPO.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-rocketracer}"
STAGING_SERVICE="${STAGING_SERVICE:-${SERVICE}-staging}"
AR_REPO="${AR_REPO:-rocketracer}"
BRANCH="${BRANCH:-main}"
GITHUB_REPO="${GITHUB_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##' || true)}"

if [[ -z "${PROJECT}" || "${PROJECT}" == "(unset)" ]]; then
  echo "No project set. Run: PROJECT=your-project-id ./tools/setup-cicd.sh" >&2; exit 1
fi
if [[ ! "${GITHUB_REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Could not work out the GitHub repo. Run: GITHUB_REPO=owner/name ./tools/setup-cicd.sh" >&2; exit 1
fi

echo "==> Project ${PROJECT}, region ${REGION}"
echo "==> Production service ${SERVICE}, staging service ${STAGING_SERVICE}"
echo "==> Trusting GitHub repo ${GITHUB_REPO} (production: branch ${BRANCH} only)"

exists() { "$@" >/dev/null 2>&1; }
svc() { gcloud run services "$@" --project "${PROJECT}" --region "${REGION}"; }

if ! exists svc describe "${SERVICE}"; then
  echo "Cloud Run service '${SERVICE}' not found in ${REGION}. Deploy once first with ./deploy.sh" >&2; exit 1
fi
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"

echo "==> Enabling APIs"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  artifactregistry.googleapis.com run.googleapis.com --project "${PROJECT}"

echo "==> Staging service ${STAGING_SERVICE}"
if exists svc describe "${STAGING_SERVICE}"; then
  echo "    already exists"
else
  # First build comes from this checkout; after that the pipeline keeps it up to date.
  PROJECT="${PROJECT}" REGION="${REGION}" STAGING=1 SERVICE="${STAGING_SERVICE}" ./deploy.sh
fi

echo "==> Artifact Registry repo ${AR_REPO}"
if ! exists gcloud artifacts repositories describe "${AR_REPO}" --location "${REGION}" --project "${PROJECT}"; then
  gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location "${REGION}" \
    --description "Rocket Racer images" --project "${PROJECT}"
fi

# setup_deployer <account id> <service> <image-repo role> <identity pool> <who GitHub must be>
# Creates one deploy account, gives it the minimum it needs for one service,
# and lets matching GitHub Actions runs act as it. Echoes nothing but progress.
setup_deployer() {
  local id="$1" service="$2" ar_role="$3" pool="$4" condition="$5"
  local email="${id}@${PROJECT}.iam.gserviceaccount.com" member provider="rocketracer-repo" runtime
  member="serviceAccount:${email}"

  echo "==> Deploy account ${email} for ${service}"
  if ! exists gcloud iam service-accounts describe "${email}" --project "${PROJECT}"; then
    gcloud iam service-accounts create "${id}" --display-name "Rocket Racer deployer: ${service}" --project "${PROJECT}"
  fi
  svc add-iam-policy-binding "${service}" --member "${member}" --role roles/run.developer --quiet >/dev/null
  gcloud artifacts repositories add-iam-policy-binding "${AR_REPO}" --project "${PROJECT}" --location "${REGION}" \
    --member "${member}" --role "${ar_role}" --quiet >/dev/null
  # rolling out a revision that runs "as" the service's own account needs permission to act as it
  runtime="$(svc describe "${service}" --format='value(spec.template.spec.serviceAccountName)')"
  runtime="${runtime:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
  gcloud iam service-accounts add-iam-policy-binding "${runtime}" --project "${PROJECT}" \
    --member "${member}" --role roles/iam.serviceAccountUser --quiet >/dev/null

  # Each deployer gets its own identity pool, so a token accepted for staging
  # (any branch) can never be used as the production deployer (main only).
  if ! exists gcloud iam workload-identity-pools describe "${pool}" --location=global --project "${PROJECT}"; then
    gcloud iam workload-identity-pools create "${pool}" --location=global --display-name "GitHub Actions: ${service}" --project "${PROJECT}"
  fi
  if ! exists gcloud iam workload-identity-pools providers describe "${provider}" --workload-identity-pool "${pool}" \
    --location=global --project "${PROJECT}"; then
    gcloud iam workload-identity-pools providers create-oidc "${provider}" \
      --workload-identity-pool "${pool}" --location=global --project "${PROJECT}" \
      --issuer-uri "https://token.actions.githubusercontent.com" \
      --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
      --attribute-condition "${condition}"
  fi
  gcloud iam service-accounts add-iam-policy-binding "${email}" --project "${PROJECT}" \
    --role roles/iam.workloadIdentityUser --quiet >/dev/null \
    --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${pool}/attribute.repository/${GITHUB_REPO}"
}

PROD_DEPLOYER="rocketracer-deployer"
STG_DEPLOYER="rocketracer-stg-deployer"
PROD_POOL="github"
STG_POOL="github-staging"

# Production only rolls out images the staging stage already built and tested, so it only needs to read them.
setup_deployer "${PROD_DEPLOYER}" "${SERVICE}" roles/artifactregistry.reader "${PROD_POOL}" \
  "assertion.repository == '${GITHUB_REPO}' && assertion.ref == 'refs/heads/${BRANCH}'"
setup_deployer "${STG_DEPLOYER}" "${STAGING_SERVICE}" roles/artifactregistry.writer "${STG_POOL}" \
  "assertion.repository == '${GITHUB_REPO}'"

provider_name() { echo "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/$1/providers/rocketracer-repo"; }
sa_email() { echo "$1@${PROJECT}.iam.gserviceaccount.com"; }

cat <<EOF

Done.
  Production: $(svc describe "${SERVICE}" --format='value(status.url)')
  Staging:    $(svc describe "${STAGING_SERVICE}" --format='value(status.url)')

Add these six variables to the GitHub repo
(Settings > Secrets and variables > Actions > Variables tab > New repository variable):

  GCP_PROJECT_ID        ${PROJECT}
  GCP_REGION            ${REGION}
  WIF_PROVIDER          $(provider_name "${PROD_POOL}")
  DEPLOYER_SA           $(sa_email "${PROD_DEPLOYER}")
  STAGING_WIF_PROVIDER  $(provider_name "${STG_POOL}")
  STAGING_DEPLOYER_SA   $(sa_email "${STG_DEPLOYER}")

Or, with the GitHub CLI signed in:

  gh variable set GCP_PROJECT_ID       --repo ${GITHUB_REPO} --body '${PROJECT}'
  gh variable set GCP_REGION           --repo ${GITHUB_REPO} --body '${REGION}'
  gh variable set WIF_PROVIDER         --repo ${GITHUB_REPO} --body '$(provider_name "${PROD_POOL}")'
  gh variable set DEPLOYER_SA          --repo ${GITHUB_REPO} --body '$(sa_email "${PROD_DEPLOYER}")'
  gh variable set STAGING_WIF_PROVIDER --repo ${GITHUB_REPO} --body '$(provider_name "${STG_POOL}")'
  gh variable set STAGING_DEPLOYER_SA  --repo ${GITHUB_REPO} --body '$(sa_email "${STG_DEPLOYER}")'

(Only if you changed the names: CLOUD_RUN_SERVICE='${SERVICE}', STAGING_SERVICE='${STAGING_SERVICE}', AR_REPO='${AR_REPO}'.)
EOF
