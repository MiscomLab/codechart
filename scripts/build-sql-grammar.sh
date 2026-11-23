#!/usr/bin/env bash
# Builds packages/core/grammars/tree-sitter-sql.wasm from the pinned DerekStride SQL grammar, which ships no .wasm.
# Run it only to change the grammar version; packages/core/tests/code/entities-rules.test.ts pins the result's sha256.
set -euo pipefail

VERSION=0.3.13
TARBALL_SHA256=6e4d930bc5c80d452d3461c63b5f7f68cff9f607ab5d4bc4b78fc6517f58fe66
CLI=tree-sitter-cli@0.27.2

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
npm pack --silent "@derekstride/tree-sitter-sql@$VERSION" >/dev/null
tarball="derekstride-tree-sitter-sql-$VERSION.tgz"
echo "$TARBALL_SHA256  $tarball" | shasum -a 256 -c -
tar xzf "$tarball"
# tree-sitter downloads the wasi-sdk clang it compiles with on first use.
(cd package && npx --yes "$CLI" build --wasm -o "$work/tree-sitter-sql.wasm" .)
mkdir -p "$root/packages/core/grammars"
cp "$work/tree-sitter-sql.wasm" "$root/packages/core/grammars/tree-sitter-sql.wasm"
shasum -a 256 "$root/packages/core/grammars/tree-sitter-sql.wasm"
