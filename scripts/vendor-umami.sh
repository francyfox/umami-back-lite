#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-$(gh api repos/umami-software/umami/releases/latest --jq .tag_name)}"
DEST="vendor/umami"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Vendoring umami-software/umami @ ${VERSION}"

curl -sL "https://github.com/umami-software/umami/archive/refs/tags/${VERSION}.tar.gz" \
  | tar -xz -C "$WORKDIR" --strip-components=1

rm -rf "$DEST"
mkdir -p "$DEST/src/app" "$DEST/prisma"

cp -r "$WORKDIR/src/lib"         "$DEST/src/lib"
cp -r "$WORKDIR/src/queries"     "$DEST/src/queries"
cp -r "$WORKDIR/src/permissions" "$DEST/src/permissions"
cp -r "$WORKDIR/src/app/api"     "$DEST/src/app/api"     # full tree, no whitelist
cp    "$WORKDIR/prisma/schema.prisma" "$DEST/prisma/schema.prisma"
cp -r "$WORKDIR/prisma/migrations"    "$DEST/prisma/migrations"

echo "$VERSION" > "$DEST/UMAMI_VERSION"

echo "Vendored ${VERSION} into ${DEST}"
