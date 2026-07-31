#!/usr/bin/env bash
# A fake `docker` for deploy/tests/test_autodeploy.sh.
#
# The test copies this to a temp dir as `docker`, puts that dir first on PATH,
# and sources autodeploy.sh — so the real script's real logic runs, and every
# docker call lands here instead of on a live daemon.
#
# The world it answers from is a directory of small files ($STUB_STATE):
#   images/<image ref>      the image ID that reference resolves to on the box
#   running/<service>       the container ID `compose ps -q <service>` returns
#   containers/<container>  the image ID that container was created from
#   pull_delivers/<ref>     an image ID a `compose pull` will install for <ref>
#   calls.log               every invocation, for the test's assertions
# A missing file means "not on this box", modelled the way the real command
# reports it: `inspect` fails (exit 1), while `compose ps -q` for a service with
# no container succeeds and prints nothing. Those differ, and the difference
# matters — it's what makes "no running container" a redeploy rather than an
# error.
#
# In image-ref filenames `/` and `:` are replaced with `_` (see sanitize below
# and in the test), since they can't be used in a path.
set -uo pipefail

state="${STUB_STATE:?stub docker needs STUB_STATE set}"
echo "docker $*" >>"$state/calls.log"

args="$*"
last="${@: -1}"

sanitize() { printf '%s' "$1" | tr '/:' '__'; }

case "$args" in
  "image inspect"*)
    file="$state/images/$(sanitize "$last")"
    [[ -f "$file" ]] || exit 1
    cat "$file"
    echo
    ;;
  "container inspect"*)
    file="$state/containers/$last"
    [[ -f "$file" ]] || exit 1
    cat "$file"
    echo
    ;;
  "image prune"*) ;;
  *" ps -q "*)
    file="$state/running/$last"
    # No container for that service: real compose prints nothing and exits 0.
    [[ -f "$file" ]] || exit 0
    cat "$file"
    echo
    ;;
  *" pull "*)
    for delivered in "$state"/pull_delivers/*; do
      [[ -e "$delivered" ]] || continue
      cp "$delivered" "$state/images/$(basename "$delivered")"
    done
    ;;
  *" up -d "*) ;;
  *" ps") ;;
  *)
    echo "stub docker: unhandled invocation: docker $*" >&2
    exit 127
    ;;
esac
exit 0
