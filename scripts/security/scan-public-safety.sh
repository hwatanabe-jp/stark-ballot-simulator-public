#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Usage:
  scripts/security/scan-public-safety.sh --staged
  scripts/security/scan-public-safety.sh --all
  scripts/security/scan-public-safety.sh --files <file>...

Scans text files for high-confidence secrets and publishable-repo safety leaks.
The report intentionally prints rule IDs only, not matched values.
EOF
}

mode="staged"
explicit_files=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --staged)
      mode="staged"
      shift
      ;;
    --all)
      mode="all"
      shift
      ;;
    --files)
      mode="files"
      shift
      while [ "$#" -gt 0 ]; do
        explicit_files+=("$1")
        shift
      done
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  is_git_repo=true
else
  repo_root="$(pwd)"
  is_git_repo=false
fi
cd "$repo_root"

should_skip_path() {
  local path="$1"
  case "$path" in
    .git/*|node_modules/*|.next/*|out/*|dist/*|build/*|coverage/*|.nyc_output/*)
      return 0
      ;;
    zkvm/target/*|verifier-service/target/*|test-results/*|playwright-report/*)
      return 0
      ;;
    .tmp/*|.temp/*|.verifier-bundles/*|.amplify/*)
      return 0
      ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.zip|*.gz|*.tgz|*.wasm)
      return 0
      ;;
  esac
  return 1
}

scan_file() {
  local display_path="$1"
  local source_path="$2"

  if [ ! -f "$source_path" ]; then
    return 0
  fi

  if ! LC_ALL=C grep -Iq . "$source_path"; then
    return 0
  fi

  perl -Mstrict -Mwarnings - "$display_path" "$source_path" <<'PERL'
my ($display_path, $source_path) = @ARGV;

open my $fh, '<', $source_path or die "cannot open $source_path: $!";

my %allowed_account_ids = map { $_ => 1 } qw(
  000000000000
  111111111111
  111122223333
  123456789012
  999999999999
);

my @simple_rules = (
  ['aws_access_key_id', qr/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private_key_block', qr/-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/],
  ['github_token', qr/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ['openai_api_key', qr/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['slack_token', qr/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google_api_key', qr/\bAIza[0-9A-Za-z_-]{35}\b/],
  ['local_user_path', qr{(?:file://)?/(?:home|Users)/[^/\s"']+(?:/[^\s"']+)+}],
  ['windows_user_path', qr{[A-Za-z]:\\Users\\[^\\\s"']+\\}],
  ['cognito_identity_pool_id', qr/\b[a-z]{2}-[a-z]+-[0-9]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/],
  ['cognito_user_pool_id', qr/\b[a-z]{2}-[a-z]+-[0-9]_[A-Za-z0-9]{9,}\b/],
  ['aws_iam_unique_id', qr/\b(?:AIDA|AROA|AGPA|ANPA|AIPA)[A-Z0-9]{16,}\b/],
  ['amplify_placeholder_stack_suffix', qr/\bamplify-<AMPLIFY_APP_ID>-[A-Za-z0-9-]+-branch-[0-9a-f]{8,12}\b/],
  ['amplify_generated_resource_name', qr/\bamplify-starkballotsimulator-[A-Za-z0-9][A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*\b/],
  ['amplify_generated_logical_id', qr/\bamplify[A-Za-z]+[0-9A-F]{8,}\b/],
  ['personal_mfa_device_name', qr/\b(?:mfa\/)?smartphone_\d+\b/],
  ['gpg_fingerprint', qr/\b(?:pass init|Password store initialized for)\s+[0-9A-F]{32,}\b/],
);

my @account_rules = (
  ['aws_account_arn', qr/\barn:aws(?:-[a-z]+)?:[A-Za-z0-9-]+:[A-Za-z0-9-]*:(\d{12}):/],
  ['ecr_account_registry', qr/\b(\d{12})\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\b/],
  ['sqs_account_url', qr{\bhttps://sqs\.[a-z0-9-]+\.amazonaws\.com/(\d{12})\b}],
);

my @amplify_rules = (
  ['amplify_app_origin', qr{\bhttps://[a-z0-9-]+\.([a-z0-9]{13})\.amplifyapp\.com\b}],
  ['amplify_stack_name', qr/\bamplify-([a-z0-9]{13})-[a-z0-9-]+-branch-[0-9a-f]{8,12}\b/],
);

my @resource_rules = (
  ['appsync_graphql_endpoint', qr{\bhttps://[a-z0-9]{26}\.appsync-api\.[a-z0-9-]+\.amazonaws\.com/graphql\b}],
  ['appsync_api_id', qr/\b(?:AMPLIFY_DATA_API_ID|amplifyDataApiId|AppSync API ID|API ID|--api-id)\b[^A-Za-z0-9_-]*[`"']?([a-z0-9]{26})\b/],
  ['aws_resource_id', qr/\b(?:subnet|sg|vpc|ami|rtb|nat|eipalloc|igw|vpce)-[0-9a-f]{8,}\b/],
);

while (my $line = <$fh>) {
  for my $rule (@simple_rules) {
    my ($name, $regex) = @$rule;
    if ($line =~ $regex) {
      print "$display_path:$.: $name\n";
    }
  }

  for my $rule (@account_rules) {
    my ($name, $regex) = @$rule;
    while ($line =~ /$regex/g) {
      my $account_id = $1;
      next if $allowed_account_ids{$account_id};
      print "$display_path:$.: $name\n";
    }
  }

  for my $rule (@amplify_rules) {
    my ($name, $regex) = @$rule;
    while ($line =~ /$regex/g) {
      my $app_id = $1;
      next if $app_id =~ /x{4,}/;
      print "$display_path:$.: $name\n";
    }
  }

  for my $rule (@resource_rules) {
    my ($name, $regex) = @$rule;
    if ($line =~ $regex) {
      print "$display_path:$.: $name\n";
    }
  }

  while ($line =~ /\bstark-ballot-simulator-proof-bundles-([a-z0-9][a-z0-9-]*)\b/g) {
    my $suffix = $1;
    next if $suffix =~ /^(?:develop|main)$/;
    print "$display_path:$.: project_s3_bucket_name\n";
  }
}
PERL
}

issues_file="$(mktemp)"
trap 'rm -f "$issues_file"' EXIT

scan_worktree_path() {
  local path="$1"

  if should_skip_path "$path"; then
    return 0
  fi

  scan_file "$path" "$path" >>"$issues_file"
}

scan_index_path() {
  local path="$1"
  local staged_copy

  if should_skip_path "$path"; then
    return 0
  fi

  staged_copy="$(mktemp)"
  if git show ":$path" >"$staged_copy" 2>/dev/null; then
    scan_file "$path" "$staged_copy" >>"$issues_file"
  fi
  rm -f "$staged_copy"
}

list_all_paths() {
  if [ "$is_git_repo" = true ]; then
    git ls-files -z
    return
  fi

  while IFS= read -r -d '' path; do
    path="${path#./}"
    if [ -n "$path" ]; then
      printf '%s\0' "$path"
    fi
  done < <(find . -type f -print0)
}

case "$mode" in
  staged)
    if [ "$is_git_repo" != true ]; then
      echo "--staged requires a git repository." >&2
      exit 2
    fi
    while IFS= read -r -d '' path; do
      scan_index_path "$path"
    done < <(git diff --cached --name-only -z --diff-filter=ACMR)
    ;;
  all)
    while IFS= read -r -d '' path; do
      scan_worktree_path "$path"
    done < <(list_all_paths)
    ;;
  files)
    if [ "${#explicit_files[@]}" -eq 0 ]; then
      echo "--files requires at least one file." >&2
      exit 2
    fi
    for path in "${explicit_files[@]}"; do
      scan_worktree_path "$path"
    done
    ;;
  *)
    echo "Internal error: unsupported mode $mode" >&2
    exit 2
    ;;
esac

if [ -s "$issues_file" ]; then
  echo "Public safety scan failed. Replace real values with placeholders before committing." >&2
  echo "Matched rule locations:" >&2
  cat "$issues_file" >&2
  exit 1
fi

echo "Public safety scan passed ($mode)."
