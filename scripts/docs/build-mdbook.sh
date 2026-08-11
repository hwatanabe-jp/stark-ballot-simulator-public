#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

if [ "$#" -gt 1 ]; then
  printf '%s\n' 'Usage: build-mdbook.sh [book-directory]' >&2
  exit 64
fi

book_directory="${1:-public-book}"
required_mdbook_version='mdbook v0.5.4'
required_mermaid_version='mdbook-mermaid 0.17.0'
compatible_warning="Warning: The mdbook-mermaid preprocessor was built against version 0.5.0 of mdbook, but we're being called from version 0.5.4"

observed_mdbook_version="$(mdbook --version)"
observed_mermaid_version="$(mdbook-mermaid --version)"
if [ "${observed_mdbook_version}" != "${required_mdbook_version}" ] ||
  [ "${observed_mermaid_version}" != "${required_mermaid_version}" ]; then
  printf '%s\n' \
    "Public book build requires ${required_mdbook_version} and ${required_mermaid_version}." >&2
  exit 1
fi

build_work_directory="$(mktemp -d "${TMPDIR:-/tmp}/stark-ballot-mdbook-build.XXXXXX")"
trap 'rm -rf -- "${build_work_directory}"' EXIT

build_stderr="${build_work_directory}/stderr"
if mdbook build "${book_directory}" 2>"${build_stderr}"; then
  build_status=0
else
  build_status=$?
fi

while IFS= read -r diagnostic || [ -n "${diagnostic}" ]; do
  if [ "${diagnostic}" != "${compatible_warning}" ]; then
    printf '%s\n' "${diagnostic}" >&2
  fi
done <"${build_stderr}"

exit "${build_status}"
