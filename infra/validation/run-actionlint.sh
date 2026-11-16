#!/usr/bin/env bash
set -euo pipefail

readonly ACTIONLINT_VERSION='1.7.12'
readonly ACTIONLINT_ARCHIVE="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
readonly ACTIONLINT_SHA256='8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'
readonly ACTIONLINT_URL="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${ACTIONLINT_ARCHIVE}"

scan_directory="$(mktemp -d)"
trap 'rm -rf "${scan_directory}"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${scan_directory}/${ACTIONLINT_ARCHIVE}" \
  "${ACTIONLINT_URL}"

printf '%s  %s\n' \
  "${ACTIONLINT_SHA256}" \
  "${scan_directory}/${ACTIONLINT_ARCHIVE}" | sha256sum --check --strict

tar --extract --gzip \
  --file "${scan_directory}/${ACTIONLINT_ARCHIVE}" \
  --directory "${scan_directory}" \
  actionlint

# Shell problems (warning and error) fail the check; shellcheck style hints do not.
SHELLCHECK_OPTS="${SHELLCHECK_OPTS:---severity=warning}" "${scan_directory}/actionlint" -color
