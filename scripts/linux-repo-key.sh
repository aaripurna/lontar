#!/bin/sh
# Makes the GPG key that signs Lontar's APT and DNF repositories (and the .rpm). Run it once:
#   scripts/linux-repo-key.sh
# It writes the public key to linux/lontar.asc, which the .deb and .rpm install so the system
# trusts the repositories, and the private key to the file it names, to save as the
# LINUX_REPO_GPG_KEY secret of the GitHub repository. Keep a backup of the private key: a new key
# means every installed copy stops trusting the repositories until it's reinstalled by hand.
set -eu
cd "$(dirname "$0")/.."

if [ -e linux/lontar.asc ]; then
  echo "linux/lontar.asc already exists; delete it first to make a new key." >&2
  exit 1
fi

home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
export GNUPGHOME="$home"

# No passphrase: the key lives only in the GitHub secret (and your backup), and CI signs unattended.
gpg --batch --quiet --passphrase '' --quick-gen-key "Lontar packages" rsa4096 sign never
gpg --armor --export "Lontar packages" > linux/lontar.asc

private="$HOME/lontar-linux-repo-key.asc"
(umask 077 && gpg --armor --export-secret-keys "Lontar packages" > "$private")

echo "Public key:  linux/lontar.asc (commit it)"
echo "Private key: $private"
echo "  1. Paste it into GitHub: Settings > Secrets and variables > Actions > New repository"
echo "     secret, named LINUX_REPO_GPG_KEY."
echo "  2. Move it somewhere safe (a password manager) and delete it from your home folder."
