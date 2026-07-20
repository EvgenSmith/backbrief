#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# sanitize-check.sh — Backbrief kit sanitize gate.
# CI-blocking. This shipped scanner is GENERIC on purpose: it hunts secret
# token SHAPES, real-looking Slack-id SHAPES, and n8n workflow-JSON hygiene,
# and lints SPDX headers against path (MIT everywhere, BUSL-1.1 under
# pipeline/). It carries NO company-specific denylist — a scanner that listed
# the exact names/ids/channels it protects would itself disclose them.
#
# Company/tenant-specific patterns load from an EXTERNAL file instead:
#   --denylist <file>   one extended-regex entry per line; kept OUT of the
#                       public export (the kit maintainers' internal CI keeps
#                       its own file OUTSIDE the kit tree (ops/backbrief-denylist.txt), which never ships).
#
# Denylist file format:
#   - blank lines and lines starting with '#' are ignored
#   - "label<TAB>flags<TAB>pattern"  (flags: grep flags such as -iE or -E)
#   - a plain line is treated as "-E" with the pattern as its own label
#
# Notes:
#   - This script and the denylist file are self-excluded from the scan.
#   - `design/` is excluded: internal design history, not part of the public
#     export (the release process exports into a fresh-history repo and
#     leaves design/ behind).
#   - Slack-id shape scan allows obviously-synthetic ids containing "00000"
#     (test fixtures use U00000…/C00000… placeholders).
#
# Usage:
#   plugin/scripts/sanitize-check.sh [--denylist-only|--spdx-only]
#                                    [--denylist <file>] [ROOT]
#
# Exit codes: 0 clean / 1 violations found / 2 operational error.

set -u

MODE="all"
ROOT=""
DENYLIST_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --denylist-only) MODE="denylist" ;;
    --spdx-only)     MODE="spdx" ;;
    --denylist)
      shift
      DENYLIST_FILE="${1:-}"
      [ -n "$DENYLIST_FILE" ] || { echo "--denylist needs a file argument" >&2; exit 2; } ;;
    -h|--help)
      sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) ROOT="$1" ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$ROOT" || { echo "cannot cd to $ROOT" >&2; exit 2; }

if [ -n "$DENYLIST_FILE" ] && [ ! -f "$DENYLIST_FILE" ]; then
  echo "denylist file not found: $DENYLIST_FILE" >&2
  exit 2
fi

SELF="plugin/scripts/sanitize-check.sh"
VIOLATIONS=0

# Common exclusions for every scan.
GREP_EXCLUDES=(
  --exclude-dir=.git
  --exclude-dir=node_modules
  --exclude-dir=design
  --binary-files=without-match
  -r -n
)

scan() { # scan <label> <grep-flags> <pattern>
  local label="$1" flags="$2" pattern="$3"
  local hits
  hits=$(grep "${GREP_EXCLUDES[@]}" $flags -e "$pattern" . 2>/dev/null \
    | grep -v "^\./${SELF}:" | grep -v "^${SELF}:")
  if [ -n "$DENYLIST_FILE" ] && [ -n "$hits" ]; then
    hits=$(echo "$hits" | grep -v "^\./${DENYLIST_FILE}:" | grep -v "^${DENYLIST_FILE}:")
  fi
  if [ -n "$hits" ]; then
    echo "✖ denylist [$label]:"
    echo "$hits" | sed 's/^/    /' | head -40
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
}

if [ "$MODE" != "spdx" ]; then
  echo "== generic sanitize scan =="

  # -- secrets & secret shapes -------------------------------------------------
  # Patterns require a plausible token tail so that documentation mentions
  # ("paste your xoxb-... token") and the SECRET_SCRUB regex *sources* in
  # deploy tooling do not false-positive — only actual token literals trip.
  scan "Slack token shape"        "-E"  'xox[bpoas]-[0-9][0-9A-Za-z-]{8,}'
  scan "Linear API key shape"     "-E"  'lin_api_[A-Za-z0-9]{10,}'
  scan "GitHub token shape"       "-E"  'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
  scan "Anthropic key shape"      "-E"  'sk-ant-[A-Za-z0-9_-]{12,}'

  # -- Slack coordinates: anything that LOOKS like a real workspace id --------
  # Synthetic fixture ids must contain "00000" to be allowed.
  hits=$(grep "${GREP_EXCLUDES[@]}" -oE '\b[UC]0[A-Z0-9]{9,}\b' . 2>/dev/null \
    | grep -v "^\./${SELF}:" | grep -v '00000')
  if [ -n "$hits" ]; then
    echo "✖ denylist [Slack-id shape (non-synthetic)]:"
    echo "$hits" | sed 's/^/    /' | head -40
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  # -- external denylist (maintainer/tenant-specific patterns) -----------------
  if [ -n "$DENYLIST_FILE" ]; then
    echo "== external denylist scan ($DENYLIST_FILE) =="
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno + 1))
      case "$line" in ''|'#'*) continue ;; esac
      label="$line"; flags="-E"; pattern="$line"
      case "$line" in
        *"$(printf '\t')"*)
          label="${line%%$(printf '\t')*}"
          rest="${line#*$(printf '\t')}"
          flags="${rest%%$(printf '\t')*}"
          pattern="${rest#*$(printf '\t')}"
          if [ "$flags" = "$pattern" ]; then flags="-E"; fi ;;
      esac
      if [ -z "$pattern" ]; then
        echo "✖ denylist file line $lineno: empty pattern" >&2
        exit 2
      fi
      scan "$label" "$flags" "$pattern"
    done < "$DENYLIST_FILE"
  fi

  # -- workflow JSON hygiene: no staticData, no live exports -------------------
  if [ -d pipeline/workflows ]; then
    for wf in pipeline/workflows/*.json; do
      [ -e "$wf" ] || continue
      if grep -q '"staticData"' "$wf"; then
        echo "✖ workflow JSON carries staticData (SECRET_SCRUB must drop it): $wf"
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
      if grep -qE '"(pinData|sharedWithProjects)"' "$wf"; then
        echo "✖ workflow JSON carries live-export fields (pinData/shared): $wf"
        VIOLATIONS=$((VIOLATIONS + 1))
      fi
    done
  fi
  if [ -d workflows/live ] || [ -d pipeline/workflows/live ]; then
    echo "✖ live workflow exports must not ship (clean generalized JSON only)"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
fi

if [ "$MODE" != "denylist" ]; then
  echo "== SPDX header lint (exemptions per CONTRIBUTING.md) =="
  # MIT everywhere; BUSL-1.1 under pipeline/. Exempt: JSON (no comments),
  # LICENSE texts, VERSION, verbatim-copied vault/frontmatter templates.
  while IFS= read -r f; do
    rel="${f#./}"
    case "$rel" in
      .git/*|design/*|node_modules/*) continue ;;
      LICENSE|pipeline/LICENSE|VERSION) continue ;;
      plugin/templates/vault-skeleton/*|plugin/templates/frontmatter/*) continue ;;
      "$SELF") ;; # the gate lints itself like any other script
    esac
    case "$rel" in
      *.js|*.sh|*.yaml|*.yml|*.toml|*.md) ;;
      *) continue ;;
    esac
    expected="MIT"
    case "$rel" in pipeline/*) expected="BUSL-1.1" ;; esac
    header=$(head -3 "$f" | grep -o 'SPDX-License-Identifier: [A-Za-z0-9.-]*' | head -1)
    if [ -z "$header" ]; then
      echo "✖ SPDX header missing: $rel (expected $expected)"
      VIOLATIONS=$((VIOLATIONS + 1))
    elif [ "$header" != "SPDX-License-Identifier: $expected" ]; then
      echo "✖ SPDX mismatch: $rel has \"$header\", path requires $expected"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done < <(find . -type f -not -path './.git/*' -not -path './design/*' -not -path './node_modules/*')
fi

echo
if [ "$VIOLATIONS" -gt 0 ]; then
  echo "✖ sanitize-check: $VIOLATIONS violation group(s) — the tree is NOT publishable"
  exit 1
fi
echo "✔ sanitize-check: clean"
exit 0
