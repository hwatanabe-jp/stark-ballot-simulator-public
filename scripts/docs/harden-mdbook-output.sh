#!/usr/bin/env bash
set -euo pipefail

book_dir="${1:-public-book/book}"

if [[ ! -d "${book_dir}" ]]; then
  echo "error: book directory not found: ${book_dir}" >&2
  exit 1
fi

has_hardening_marker() {
  local file="$1"

  if command -v rg >/dev/null 2>&1; then
    rg -F -q -- 'name="x-mdbook-security-hardened"' "${file}"
  else
    grep -F -q -- 'name="x-mdbook-security-hardened"' "${file}"
  fi
}

inject_security_meta() {
  local file="$1"

  if has_hardening_marker "${file}"; then
    return 0
  fi

  local temp_file
  temp_file="$(mktemp)"

  local inserted=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    printf '%s\n' "${line}" >>"${temp_file}"

    if [[ ${inserted} -eq 0 && "${line}" =~ \<meta[[:space:]]+charset= ]]; then
      cat >>"${temp_file}" <<'HTML'
        <meta name="x-mdbook-security-hardened" content="true">
        <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'self'; upgrade-insecure-requests">
        <meta name="referrer" content="no-referrer">
        <script>
            // Best-effort frame-busting for GitHub Pages where response headers cannot be customized.
            if (window.top !== window.self) {
                window.top.location = window.self.location.href;
            }
        </script>
HTML
      inserted=1
    fi
  done <"${file}"

  if [[ ${inserted} -ne 1 ]]; then
    rm -f "${temp_file}"
    echo "error: could not locate charset meta tag in ${file}" >&2
    exit 1
  fi

  mv "${temp_file}" "${file}"
}

updated=0
count=0
while IFS= read -r -d '' file; do
  count=$((count + 1))
  if ! has_hardening_marker "${file}"; then
    updated=$((updated + 1))
  fi
  inject_security_meta "${file}"
done < <(find "${book_dir}" -type f -name '*.html' -print0 | sort -z)

if [[ ${count} -eq 0 ]]; then
  echo "error: no HTML files found in ${book_dir}" >&2
  exit 1
fi

echo "Hardened ${count} HTML files (updated: ${updated}) in ${book_dir}"
