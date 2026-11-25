#!/usr/bin/env bash
# Set up OpenBao for divvun-actions: the login a Buildkite job makes with its
# own OIDC token (builder/buildkite/mod.ts), and the roles that decide which
# builds may make it. Run by an OpenBao admin against vault.giellalt.org; it
# contains no secrets.
#
#     BAO_ADDR=https://vault.giellalt.org deploy/openbao.sh
#
# Running it again changes nothing that is already right.
set -euo pipefail

: "${BAO_ADDR:?the OpenBao address, such as https://vault.giellalt.org}"

MOUNT=${MOUNT:-buildkite}
ISSUER=https://agent.buildkite.com
# The audience builder/buildkite/mod.ts asks Buildkite for: change both together.
AUDIENCE=${AUDIENCE:-https://vault.giellalt.org}
ORGANIZATION=${ORGANIZATION:-divvun}
# Every role's policies: ci-builder reads CI's secrets and keys, and
# pahkat-publish-ci, which pahkat-next's deploy/openbao.sh writes, Pahkat's
# publisher tokens.
POLICIES=(ci-builder pahkat-publish-ci)

# The pipelines whose builds may log in, by slug: those of the repositories
# util/trusted_context.ts trusts, so change the two together. keyboard-*
# also admits divvun's keyboard-sjd-x-private, which that file refuses.
PIPELINES=(
  'lang-*' 'dict-*' 'keyboard-*' 'shared-*' 'template-*'
  borealium-dot-org cg3-rs divvun-actions divvun-dev-keyboard divvun-keyboard
  divvun-runtime divvun-speech-py divvun-wind divvun-worker-grammar
  divvun-worker-speller divvun-worker-tts divvunspell divvunspell-libreoffice
  drb-kicker foma-rs frakt giella-core gut hfst-rs kbdgen kbdi
  kielipankki-donatespeech-app libpahkat msgrammar outto pahkat-next rsigncode
  teaksta
)
# Release tags as globs; TRUSTED_RELEASE_TAG in util/trusted_context.ts
# narrows them to semantic versions.
RELEASE_TAGS=('v*' 'kbd-tsf-v*' '*/v*')

step() { printf '\n== %s\n' "$*" >&2; }
exists() { bao read "$@" >/dev/null 2>&1; }
json_list() { python3 -I -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "$@"; }

step "Login auth/$MOUNT"
exists "sys/auth/$MOUNT" || bao auth enable -path="$MOUNT" jwt
bao write "auth/$MOUNT/config" \
  oidc_discovery_url="$ISSUER" \
  bound_issuer="$ISSUER"

# role NAME CLAIMS: the role NAME, for the builds in ORGANIZATION whose
# tokens also have CLAIMS, JSON members whose values are globs. Each
# pipeline is one identity; a token's metadata, which the audit log keeps
# with every request it makes, names its build and job. Buildkite's tokens
# say nothing of pull requests; that is safe only while no pipeline builds
# forks' pull requests, so that one claiming main or v4 builds that branch.
role() {
  bao write "auth/$MOUNT/role/$1" - <<EOF
{
  "role_type": "jwt",
  "user_claim": "pipeline_slug",
  "bound_audiences": ["$AUDIENCE"],
  "bound_claims_type": "glob",
  "bound_claims": {"organization_slug": "$ORGANIZATION", $2},
  "claim_mappings": {
    "pipeline_slug": "pipeline_slug",
    "build_branch": "build_branch",
    "build_tag": "build_tag",
    "build_commit": "build_commit",
    "job_id": "job_id"
  },
  "token_policies": $(json_list "${POLICIES[@]}"),
  "token_ttl": "1h",
  "token_max_ttl": "1h"
}
EOF
}

step "Roles auth/$MOUNT/role/{release,main,v4}"
pipelines=$(json_list "${PIPELINES[@]}")
role release "\"pipeline_slug\": $pipelines, \"build_tag\": $(json_list "${RELEASE_TAGS[@]}")"
role main "\"pipeline_slug\": $pipelines, \"build_branch\": \"main\""
role v4 "\"pipeline_slug\": [\"kbdgen\", \"kbdi\"], \"build_branch\": \"v4\""
