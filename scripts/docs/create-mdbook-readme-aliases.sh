#!/usr/bin/env bash
set -euo pipefail

book_dir="${1:-public-book/book}"

sections=(
  "protocol"
  "zkvm"
  "verification"
  "tamper"
  "aws"
  "api"
  "reproducibility"
  "decisions"
)

for section in "${sections[@]}"; do
  section_dir="${book_dir}/${section}"
  target="${section_dir}/index.html"
  alias_file="${section_dir}/README.html"

  if [[ ! -f "${target}" ]]; then
    echo "skip: ${target} not found" >&2
    continue
  fi

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
