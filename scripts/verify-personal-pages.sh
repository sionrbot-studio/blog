#!/usr/bin/env bash
set -euo pipefail

sha=${1:-}
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Expected the full commit SHA from the personal Pages repository.' >&2
  exit 1
fi

api='https://api.github.com/repos/sionrbot/sionrbot.github.io'
site='https://sionrbot.github.io/'
curl_args=(--silent --show-error --connect-timeout 5 --max-time 10
  --header 'Accept: application/vnd.github+json' --header 'Cache-Control: no-cache')

read_api() {
  local path=$1 response status
  if [[ -n "${GH_TOKEN:-}" ]]; then
    response=$(curl -q "${curl_args[@]}" --config - --write-out $'\n%{http_code}' "$api/$path" \
      <<< "header = \"Authorization: Bearer $GH_TOKEN\"") || return
    status=${response##*$'\n'}
    case "$status" in
      200) printf '%s\n' "${response%$'\n'*}"; return ;;
      403|404) ;; # An installation token may be scoped to the source repository.
      *) echo "GitHub API returned HTTP $status for $path." >&2; return 1 ;;
    esac
  fi
  curl -q "${curl_args[@]}" --fail "$api/$path"
}

deadline=$((SECONDS + 300))
while (( SECONDS < deadline )); do
  deployments=$(read_api "deployments?sha=$sha&ref=main&environment=github-pages")
  deployment=$(jq -r --arg sha "$sha" '
    map(select(.sha == $sha and .ref == "main" and .environment == "github-pages"))
    | max_by([.created_at, .id]) | .id // empty
  ' <<< "$deployments")
  if [[ -n "$deployment" ]]; then
    statuses=$(read_api "deployments/$deployment/statuses")
    latest=$(jq -c 'max_by([.created_at, .id])' <<< "$statuses")
    state=$(jq -r '.state // empty' <<< "$latest")
    case "$state" in
      success)
        if ! jq -e --arg site "$site" '.environment_url == $site' <<< "$latest" >/dev/null; then
          echo "Deployment $deployment succeeded for an unexpected Pages URL." >&2
          exit 1
        fi
        printf 'Verified personal Pages deployment %s for %s (%s).\n' \
          "$deployment" "$sha" "$(jq -r '.log_url' <<< "$latest")"
        exit 0
        ;;
      failure|error|inactive)
        echo "Personal Pages deployment $deployment for $sha is $state." >&2
        exit 1
        ;;
      ''|queued|pending|in_progress|waiting) ;;
      *)
        echo "Unexpected status '$state' for personal Pages deployment $deployment." >&2
        exit 1
        ;;
    esac
  fi
  sleep 15
done

echo "No successful personal Pages deployment for $sha within five minutes." >&2
exit 1
