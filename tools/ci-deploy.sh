#!/usr/bin/env bash
#
# Release one image to one Cloud Run service, safely. Used by the GitHub
# Actions pipeline for both staging and production.
#
#   PROJECT=... REGION=... tools/ci-deploy.sh <service> <image> [expected-env] [web|mp]
#
# `mp` rolls out the online-play service (same image, `node mp-server.js`)
# and checks it with a real WebSocket room instead of the game page. If that
# service has not been created yet (tools/setup-cicd.sh), it is skipped.
#
#   1. deploy the image as a new revision that receives NO traffic
#   2. smoke-test that revision on its private "candidate" URL
#   3. only if every check passes, switch traffic to it
#
# A failure at step 1 or 2 leaves the previous revision serving. Settings
# already on the service (service account, env vars, memory, scaling) carry
# over; only the image and the COMMIT_SHA stamp change.
set -euo pipefail

SERVICE="${1:?usage: ci-deploy.sh <service> <image> [expected-env]}"
IMAGE="${2:?usage: ci-deploy.sh <service> <image> [expected-env]}"
EXPECT_ENV="${3:-}"
KIND="${4:-web}"
: "${PROJECT:?PROJECT is not set}" "${REGION:?REGION is not set}"
VERSION="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
TAG="candidate"
run() { gcloud run "$@" --project "${PROJECT}" --region "${REGION}"; }

if [[ "${KIND}" == "mp" ]] && ! run services describe "${SERVICE}" >/dev/null 2>&1; then
  echo "==> ${SERVICE}: not set up yet, so online play is skipped (run tools/setup-cicd.sh once to add it)"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "- **${SERVICE}** (online play) is not set up yet: skipped" >> "${GITHUB_STEP_SUMMARY}"; fi
  exit 0
fi

echo "==> ${SERVICE}: deploying ${IMAGE} with no traffic"
run deploy "${SERVICE}" --image "${IMAGE}" --update-env-vars "COMMIT_SHA=${VERSION}" --no-traffic --tag "${TAG}" --quiet

URL="$(run services describe "${SERVICE}" --format=json | jq -r --arg t "${TAG}" '.status.traffic[]? | select(.tag == $t) | .url' | head -n 1)"
if [[ -z "${URL}" || "${URL}" == "null" ]]; then
  echo "Could not find the URL of the candidate revision" >&2; exit 1
fi

echo "==> ${SERVICE}: smoke-testing ${URL}"
probe() { curl -fsS --retry 5 --retry-delay 3 --retry-all-errors --max-time 20 "$@"; }
check() { # check <description> <jq filter> <json>
  if ! jq -e "$2" >/dev/null <<<"$3"; then echo "FAILED: $1"; echo "  got: $3"; exit 1; fi
  echo "  ok: $1"
}
health="$(probe "${URL}/api/health")"
check "the service is up" '.ok == true' "${health}"
check "it is the revision we just built (${VERSION})" ".version == \"${VERSION}\"" "${health}"
if [[ -n "${EXPECT_ENV}" ]]; then
  check "it is configured as ${EXPECT_ENV}" ".env == \"${EXPECT_ENV}\"" "${health}"
fi
if [[ "${KIND}" == "mp" ]]; then
  check "it serves online play" '.mp == true' "${health}"
  # a real room: open it over the WebSocket, get ready, see the race start and snapshots flow
  node "$(dirname "$0")/mp-smoke.js" "${URL/https:/wss:}/ws"
else
  # reads from Firestore, so this also proves the revision's permissions work
  check "the leaderboard answers" '.scores | type == "array"' "$(probe "${URL}/api/scores?track=lunar")"
  probe "${URL}/" | grep -q 'Rocket Racer' || { echo "FAILED: the game page loads"; exit 1; }
  echo "  ok: the game page loads"
fi

echo "==> ${SERVICE}: switching traffic to the new revision"
run services update-traffic "${SERVICE}" --to-latest --quiet
LIVE="$(run services describe "${SERVICE}" --format='value(status.url)')"
echo "==> ${SERVICE} is live at ${LIVE}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "url=${LIVE}" >> "${GITHUB_OUTPUT}"; fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "- **${SERVICE}** now serves \`${VERSION:0:7}\` at ${LIVE}" >> "${GITHUB_STEP_SUMMARY}"
fi
