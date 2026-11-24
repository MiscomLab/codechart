#!/usr/bin/env bash
# Builds packages/core/grammars/tree-sitter-prisma.wasm from the pinned victorhqc Prisma grammar, which ships no .wasm.
# Run it only to change the grammar version; packages/core/tests/code/prisma.test.ts pins the result's sha256.
set -euo pipefail

VERSION=1.6.0
TARBALL_SHA256=08ed5bc5dfe99336c4ad3e036a8b735f599779402901ce39c474bf5556fd557c
CLI=tree-sitter-cli@0.27.2

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
npm pack --silent "tree-sitter-prisma@$VERSION" >/dev/null
tarball="tree-sitter-prisma-$VERSION.tgz"
echo "$TARBALL_SHA256  $tarball" | shasum -a 256 -c -
tar xzf "$tarball"
# tree-sitter downloads the wasi-sdk clang it compiles with on first use.
(cd package && npx --yes "$CLI" build --wasm -o "$work/tree-sitter-prisma.wasm" .)
mkdir -p "$root/packages/core/grammars"
cp "$work/tree-sitter-prisma.wasm" "$root/packages/core/grammars/tree-sitter-prisma.wasm"
shasum -a 256 "$root/packages/core/grammars/tree-sitter-prisma.wasm"
