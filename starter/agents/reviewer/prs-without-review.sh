#!/bin/sh
# Prints open pull requests with no review, from the repositories in repos.txt, that this agent hasn't seen yet.
set -eu
seen=.seen-prs
touch "$seen"
grep -v '^#' repos.txt | while read -r repo; do
	[ -n "$repo" ] || continue
	gh pr list --repo "$repo" --search "review:none draft:false" --json url,title,author \
		--jq '.[] | [.url, .author.login, .title] | @tsv' |
		while IFS="$(printf '\t')" read -r url who title; do
			grep -qxF "$url" "$seen" && continue
			echo "$url" >>"$seen"
			printf '%s by %s: %s\n' "$url" "$who" "$title"
		done
done
