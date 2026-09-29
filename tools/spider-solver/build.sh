#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$SCRIPT_DIR/bin"
${CXX:-c++} -std=c++17 -O3 -DNDEBUG "$SCRIPT_DIR/main.cpp" -o "$SCRIPT_DIR/bin/spider-solver"
