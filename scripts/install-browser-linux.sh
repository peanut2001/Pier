#!/usr/bin/env bash
# Install only the user's Selkies runtime. System dependencies are documented in README.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'The remote browser runtime requires Linux.' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|aarch64) browser_arch="$(uname -m)" ;;
  *) printf '%s\n' 'Supported architectures: x86_64 and aarch64.' >&2; exit 1 ;;
esac
browser_version=2.1.0
browser_parent="$HOME/.local/share/pier"
browser_target="$browser_parent/selkies-$browser_version"
if [[ -x "$browser_target/AppRun" ]]; then
  printf 'Already installed: %s\n' "$browser_target/AppRun"
  exit 0
fi
if [[ -e "$browser_target" ]]; then
  printf 'Installation path already exists; inspect it before retrying: %s\n' "$browser_target" >&2
  exit 1
fi
for browser_tool in curl sha256sum; do
  command -v "$browser_tool" >/dev/null || { printf 'Missing dependency: %s\n' "$browser_tool" >&2; exit 1; }
done
umask 077
mkdir -p "$browser_parent"
browser_stage="$(mktemp -d "$browser_parent/.selkies-install.XXXXXX")"
trap 'rm -rf -- "$browser_stage"' EXIT
browser_asset="selkies-$browser_version-$browser_arch.AppImage"
browser_release="https://github.com/selkies-project/selkies/releases/download/$browser_version"
curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --output "$browser_stage/$browser_asset" "$browser_release/$browser_asset"
curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --output "$browser_stage/SHA256SUMS" "$browser_release/SHA256SUMS"
(
  cd "$browser_stage"
  # Restrict verification to the exact asset; never execute an unchecked download.
  awk -v asset="$browser_asset" '$2 == asset || $2 == "*" asset { print }' SHA256SUMS > asset.sha256
  [[ "$(wc -l < asset.sha256)" -eq 1 ]]
  sha256sum --check asset.sha256
  chmod 700 "$browser_asset"
  "./$browser_asset" --appimage-extract > extract.log
  [[ -x squashfs-root/AppRun ]]
  mv -T -- squashfs-root "$browser_target"
)
printf 'Installed Selkies %s: %s\n' "$browser_version" "$browser_target/AppRun"
printf '%s\n' 'Pier will find it automatically. Install Xvfb, Openbox and Chrome/Chromium on this host as described in README.'
