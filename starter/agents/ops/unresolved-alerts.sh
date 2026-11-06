#!/bin/sh
# Prints alerts firing in Alertmanager that this agent hasn't seen yet. Nothing printed, no wake-up.
# Point ALERTMANAGER_URL at yours, in atc's environment, or swap this for whatever your alerts live in.
set -eu
url=${ALERTMANAGER_URL:-http://127.0.0.1:9093}
seen=.seen-alerts
touch "$seen"
curl -fsS -m 20 "$url/api/v2/alerts?active=true&silenced=false&inhibited=false" |
	jq -r '.[] | [.fingerprint, .startsAt, .labels.alertname, (.labels.instance // "-"), (.annotations.summary // "")] | @tsv' |
	while IFS="$(printf '\t')" read -r id since name where summary; do
		grep -qxF "$id" "$seen" && continue
		echo "$id" >>"$seen"
		printf '%s on %s since %s: %s\n' "$name" "$where" "$since" "$summary"
	done
