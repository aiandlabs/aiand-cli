#!/usr/bin/env bash
# backport.yml: cherry-pick a merged pull request onto release/<major>.x for
# each `backport-<major>.x` label and open a pull request there. Runs only git
# and gh. Reads, from the environment: REPO, PR, PR_TITLE, MERGE_SHA,
# PR_COMMITS, ACTION (closed or labeled), LABELS (the labels at merge time,
# space-separated), ADDED_LABEL, RUN_URL, GH_TOKEN.
# Exits non-zero when any label could not be handled; each such case is also
# a comment on the pull request.
# Backticks in the single-quoted strings are Markdown for the comments.
# shellcheck disable=SC2016
set -euo pipefail

: "${REPO:?}" "${PR:?}" "${MERGE_SHA:?}" "${ACTION:?}"
PR_COMMITS="${PR_COMMITS:-1}"
LABEL_RE='^backport-([0-9]+)\.x$'

# A closed run takes the labels the pull request had when it merged, and a
# labeled run only the label just added, so no label is handled by both.
if [ "$ACTION" = "labeled" ]; then
  LABELS="${ADDED_LABEL:-}"
else
  LABELS="$(printf '%s' "${LABELS:-}" | tr ' ' '\n')"
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git cat-file -e "$MERGE_SHA^{commit}" 2>/dev/null || git fetch --quiet origin "$MERGE_SHA"

# What GitHub put on main for this pull request:
#   merge commit       pick it against its first parent
#   squash             one commit, pick it
#   rebase, N commits  the last N commits up to the merge sha. A rebase keeps
#                      each commit's author and author date, so those N match
#                      the pull request's commits one for one. A squash commit
#                      is dated when it merged, and its message can be edited
#                      to anything, so the message proves nothing.
authors_on_main() {
  TZ=UTC git log -n "$PR_COMMITS" --reverse --format='%ae %ad' \
    --date=format-local:'%Y-%m-%dT%H:%M:%SZ' "$MERGE_SHA"
}
PARENTS="$(git rev-list --parents -n 1 "$MERGE_SHA" | wc -w | tr -d ' ')"
if [ "$PARENTS" -ge 3 ]; then
  PICK=(-m 1 "$MERGE_SHA")
elif [ "$PR_COMMITS" -gt 1 ]; then
  PR_AUTHORS="$(gh api --paginate "repos/$REPO/pulls/$PR/commits?per_page=100" --jq '.[] | .commit.author.email + " " + .commit.author.date')"
  if [ "$(authors_on_main)" = "$PR_AUTHORS" ]; then
    PICK=("$MERGE_SHA~$PR_COMMITS..$MERGE_SHA")
  else
    PICK=("$MERGE_SHA")
  fi
else
  PICK=("$MERGE_SHA")
fi

comment() {
  gh pr comment "$PR" -R "$REPO" --body "$1" > /dev/null
}

manual_steps() {
  local target="$1" branch="$2"
  printf '```sh\ngit fetch origin\ngit switch -c %s origin/%s\ngit cherry-pick -x %s\n# fix the conflicts, then: git add <files> && git cherry-pick --continue\ngit push -u origin %s\ngh pr create --base %s\n```\n' \
    "$branch" "$target" "${PICK[*]}" "$branch" "$target"
}

FAILED=0
FOUND=0
while IFS= read -r label; do
  [[ "$label" =~ $LABEL_RE ]] || continue
  FOUND=1
  MAJOR="${BASH_REMATCH[1]}"
  TARGET="release/$MAJOR.x"
  BRANCH="backport/$MAJOR.x/pr-$PR"

  if ! git ls-remote --exit-code --heads origin "$TARGET" > /dev/null; then
    comment "Not backported: \`$label\` asks for \`$TARGET\`, and that branch does not exist. ([run]($RUN_URL))"
    FAILED=1
    continue
  fi
  if git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null; then
    OPEN="$(gh pr list -R "$REPO" --head "$BRANCH" --base "$TARGET" --state open --json url --jq '.[0].url // ""')"
    if [ -n "$OPEN" ]; then
      echo "::notice::$BRANCH already has an open pull request: $OPEN"
    else
      comment "Not backported to \`$TARGET\`: the branch \`$BRANCH\` already exists with no open pull request. Delete the branch and add the \`$label\` label again, or open the pull request from it by hand. ([run]($RUN_URL))"
      FAILED=1
    fi
    continue
  fi

  git fetch --quiet origin "$TARGET"
  git switch --quiet -C "$BRANCH" "origin/$TARGET"
  if git cherry-pick -x --empty=drop "${PICK[@]}"; then
    if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$TARGET")" ]; then
      comment "Nothing to backport to \`$TARGET\`: it already has these changes."
    else
      git push --quiet origin "HEAD:refs/heads/$BRANCH"
      BODY="$(printf 'Backport of #%s to `%s`, cherry-picked from %s.\n\nOpened by the backport workflow, so CI has not started: close and reopen this pull request to start it.\n' "$PR" "$TARGET" "$MERGE_SHA")"
      URL="$(gh pr create -R "$REPO" --base "$TARGET" --head "$BRANCH" --title "[$MAJOR.x] $PR_TITLE" --body "$BODY")"
      comment "Opened $URL to bring this to \`$TARGET\`."
    fi
  else
    CONFLICTS="$(git diff --name-only --diff-filter=U || true)"
    git cherry-pick --abort > /dev/null 2>&1 || true
    if [ -n "$CONFLICTS" ]; then
      LIST="$(printf '%s\n' "$CONFLICTS" | sed 's/^/- `/; s/$/`/')"
      comment "$(printf 'Could not cherry-pick this onto `%s`: it conflicts in\n\n%s\n\nTo backport it by hand:\n\n%s\n([run](%s))' "$TARGET" "$LIST" "$(manual_steps "$TARGET" "$BRANCH")" "$RUN_URL")"
    else
      comment "$(printf 'Could not cherry-pick this onto `%s`. See the [run](%s) for why. To backport it by hand:\n\n%s' "$TARGET" "$RUN_URL" "$(manual_steps "$TARGET" "$BRANCH")")"
    fi
    FAILED=1
  fi
  git switch --quiet --detach "$MERGE_SHA"
done <<< "$LABELS"

if [ "$FOUND" = "0" ]; then
  echo "::notice::no backport-<major>.x label on #$PR"
fi
exit "$FAILED"
