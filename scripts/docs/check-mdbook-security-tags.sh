#!/usr/bin/env bash
set -euo pipefail

book_dir="${1:-public-book/book}"

if [[ ! -d "${book_dir}" ]]; then
  echo "error: book directory not found: ${book_dir}" >&2
  exit 1
fi

has_pattern() {
  local pattern="$1"
  local file="$2"

  if command -v rg >/dev/null 2>&1; then
    rg -F -q -- "${pattern}" "${file}"
  else
    grep -F -q -- "${pattern}" "${file}"
  fi
}

required_patterns=(
  'name="x-mdbook-security-hardened"'
  'http-equiv="Content-Security-Policy"'
  "default-src 'self'"
  "object-src 'none'"
  "base-uri 'none'"
  "form-action 'none'"
  'name="referrer" content="no-referrer"'
)

html_count=0
while IFS= read -r -d '' file; do
  html_count=$((html_count + 1))
  for pattern in "${required_patterns[@]}"; do
    if ! has_pattern "${pattern}" "${file}"; then
      echo "error: missing pattern '${pattern}' in ${file}" >&2
      exit 1
    fi
  done
done < <(find "${book_dir}" -type f -name '*.html' -print0 | sort -z)

if [[ ${html_count} -eq 0 ]]; then
  echo "error: no HTML files found in ${book_dir}" >&2
  exit 1
fi

echo "Security tags check passed for ${html_count} HTML files in ${book_dir}"
