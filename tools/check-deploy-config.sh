#!/usr/bin/env bash
#
# Fail early, and say why, when the pipeline's Google Cloud settings are
# missing or malformed. Without this the first sign is a cryptic error from
# the Google login step ("must specify exactly one of workload_identity_provider
# or credentials_json").
#
#   tools/check-deploy-config.sh [PREFIX]
#
# Reads GCP_PROJECT_ID, GCP_REGION, ${PREFIX}WIF_PROVIDER and ${PREFIX}DEPLOYER_SA
# from the environment: the same names as the GitHub settings. PREFIX is
# STAGING_ for the staging job and empty for production.
set -euo pipefail

P="${1:-}"
WIF="${P}WIF_PROVIDER"
SA="${P}DEPLOYER_SA"
problems=()

for name in GCP_PROJECT_ID GCP_REGION "${WIF}" "${SA}"; do
  [[ -n "${!name:-}" ]] || problems+=("${name} is not set.")
done

val() { printf '%s' "${!1:-}"; }
if [[ -n "$(val GCP_PROJECT_ID)" && ! "$(val GCP_PROJECT_ID)" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  problems+=("GCP_PROJECT_ID should be the project ID, e.g. my-game-123456 (got '$(val GCP_PROJECT_ID)').")
fi
if [[ -n "$(val GCP_REGION)" && ! "$(val GCP_REGION)" =~ ^[a-z]+-[a-z]+[0-9]+$ ]]; then
  problems+=("GCP_REGION should be a region such as us-central1 (got '$(val GCP_REGION)').")
fi
if [[ -n "$(val "${WIF}")" && ! "$(val "${WIF}")" =~ ^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$ ]]; then
  problems+=("${WIF} should look like projects/123456789/locations/global/workloadIdentityPools/github/providers/rocketracer-repo, with the project NUMBER (got '$(val "${WIF}")').")
fi
if [[ -n "$(val "${SA}")" && ! "$(val "${SA}")" =~ ^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]]; then
  problems+=("${SA} should be a service account email ending in .iam.gserviceaccount.com (got '$(val "${SA}")').")
fi

if (( ${#problems[@]} )); then
  for p in "${problems[@]}"; do echo "::error title=Deploy settings::${p}"; done
  cat <<'HELP'

The deploy can't log in to Google Cloud until these are fixed.
  1. On your computer, from this repository: PROJECT=your-project-id ./tools/setup-cicd.sh
  2. In GitHub: Settings > Secrets and variables > Actions. Add each value the
     script prints on the Variables tab (the Secrets tab works too), using
     exactly the names it shows.
  3. Re-run this workflow: Actions > CI/CD > the failed run > Re-run failed jobs.
HELP
  exit 1
fi
echo "Deploy settings look right: GCP_PROJECT_ID, GCP_REGION, ${WIF}, ${SA}."
