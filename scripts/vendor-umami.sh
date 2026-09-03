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

# MIT requires the upstream copyright/permission notice travel with their
# code — this repo vendors it verbatim (plus the mechanical NextResponse
# patch below), it doesn't rewrite it, so the notice belongs right here.
cp "$WORKDIR/LICENSE" "$DEST/LICENSE"

# Pixel beacon + short-link redirect. The only vendored files that touch
# next/server — NextResponse.redirect()/`new NextResponse()` are thin
# wrappers over the standard Response.redirect()/`new Response()`, so this
# rewrite is mechanical and doesn't change behavior. Everything else in
# these two files (business logic, imports of vendored lib/queries) stays
# untouched. src/mount.ts mounts them by name, not by glob, so a route
# rename upstream would need a matching update there.
mkdir -p "$DEST/src/app/(collect)"
cp -r "$WORKDIR/src/app/(collect)/p" "$DEST/src/app/(collect)/p"
cp -r "$WORKDIR/src/app/(collect)/q" "$DEST/src/app/(collect)/q"
for f in "$DEST/src/app/(collect)/p/[slug]/route.ts" "$DEST/src/app/(collect)/q/[slug]/route.ts"; do
  sed -i \
    -e "/^import { NextResponse } from 'next\/server';\$/d" \
    -e "s/NextResponse\.redirect(/Response.redirect(/g" \
    -e "s/new NextResponse(/new Response(/g" \
    "$f"
done

echo "$VERSION" > "$DEST/UMAMI_VERSION"

# The tracker (script.js) and session-replay/heatmap recorder (recorder.js)
# aren't in the git tree at all — both are rollup build outputs
# (src/tracker/*, src/recorder/*) upstream produces at their own build time,
# not something `cp` from the tarball can get us. Pulling them out of their
# published Docker image reuses their real build output directly, instead of
# vendoring their whole build toolchain for two files.
# Caveat: `postgresql-latest` tracks their latest release, not necessarily
# this exact $VERSION tag — acceptable since both scripts' public behavior
# has been stable across releases for years; revisit if that ever bites.
echo "Extracting script.js + recorder.js from ghcr.io/umami-software/umami:postgresql-latest"
docker pull -q ghcr.io/umami-software/umami:postgresql-latest >/dev/null
CID="$(docker create ghcr.io/umami-software/umami:postgresql-latest)"
mkdir -p "$DEST/public"
docker cp "$CID:/app/public/script.js" "$DEST/public/script.js"
docker cp "$CID:/app/public/recorder.js" "$DEST/public/recorder.js"
docker rm "$CID" >/dev/null

echo "Vendored ${VERSION} into ${DEST}"
