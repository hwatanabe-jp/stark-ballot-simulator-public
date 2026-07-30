#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

book_dir="${1:-public-book/book}"

if [[ ! -d "${book_dir}" ]]; then
  echo "error: mdBook output directory not found: ${book_dir}" >&2
  exit 1
fi

shopt -s nullglob
section_indexes=("${book_dir}"/*/index.html)
shopt -u nullglob

if ((${#section_indexes[@]} == 0)); then
  echo "error: no top-level section index files found under ${book_dir}" >&2
  exit 1
fi

for target in "${section_indexes[@]}"; do
  section_dir="${target%/index.html}"
  alias_file="${section_dir}/README.html"

  cat >"${alias_file}" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=./index.html">
  <link rel="canonical" href="./index.html">
  <title>Redirecting</title>
</head>
<body>
  <p>Redirecting to <a href="./index.html">index.html</a>...</p>
  <script>window.location.replace("./index.html");</script>
</body>
</html>
HTML
done
