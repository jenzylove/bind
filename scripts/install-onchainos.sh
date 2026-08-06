#!/bin/sh
set -eu

VERSION="v4.4.5"
REPO="okx/onchainos-skills"
INSTALL_DIR="${HOME}/.local/bin"

case "$(uname -m)" in
  x86_64)
    ASSET="onchainos-x86_64-unknown-linux-gnu"
    EXPECTED_SHA256="e344d2a38d1bcb5cbdff65d8fcdf7700862f0ff12aec871575be5a0892018a6d"
    ;;
  aarch64|arm64)
    ASSET="onchainos-aarch64-unknown-linux-gnu"
    EXPECTED_SHA256="719c2373f6e412cdec728cd3c7ace3a269e777c53f4e9c0c454047503c230a55"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
curl -fsSL --proto '=https' --tlsv1.2 "$URL" -o "$TMP"
printf '%s  %s\n' "$EXPECTED_SHA256" "$TMP" | sha256sum -c -
install -m 0755 "$TMP" "$INSTALL_DIR/onchainos"
"$INSTALL_DIR/onchainos" --version | grep -F "${VERSION#v}"
