#!/usr/bin/env bash
# publish.yml: a publish job uploads only the tarball the build job packed. The
# build job hands over the file's name and digests as job outputs, and the file
# itself as an artifact; this stops unless the artifact holds exactly that one
# file with those digests.
#
#   check-artifact.sh <dir> <tarball name> <sha256 hex> <sha512 base64>
set -euo pipefail

DIR="${1:?artifact directory}"
TGZ="${2:?tarball name}"
WANT256="${3:?sha256}"
WANT512="${4:?sha512}"

case "$TGZ" in
  aiand-cli-*.tgz) ;;
  *)
    echo "::error::the build job named $(printf '%q' "$TGZ"), not an aiand-cli-<version>.tgz"
    exit 1
    ;;
esac
if [[ "$TGZ" == */* ]]; then
  echo "::error::the build job named a path, not a file name: $(printf '%q' "$TGZ")"
  exit 1
fi

FOUND=()
while IFS= read -r -d '' path; do
  FOUND+=("${path#"$DIR"/}")
done < <(find "$DIR" -mindepth 1 -print0)
if [ "${#FOUND[@]}" -ne 1 ] || [ "${FOUND[0]}" != "$TGZ" ] || [ ! -f "$DIR/$TGZ" ] || [ -L "$DIR/$TGZ" ]; then
  echo "::error::the build artifact must hold only $TGZ; it holds:$(printf ' %q' ${FOUND[@]+"${FOUND[@]}"})"
  exit 1
fi

GOT256="$(openssl dgst -sha256 -r "$DIR/$TGZ" | cut -d' ' -f1)"
GOT512="$(openssl dgst -sha512 -binary "$DIR/$TGZ" | openssl base64 -A)"
if [ "$GOT256" != "$WANT256" ] || [ "$GOT512" != "$WANT512" ]; then
  echo "::error::$TGZ is not the file the build job packed (sha256 $GOT256, expected $WANT256). Nothing was published"
  exit 1
fi
echo "$TGZ matches the build job's sha256 $GOT256"
