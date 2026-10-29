import type { FenvixConfig } from './config';
import { ENGINE_BINARY_NAME, PATHS } from './engine-command';

/**
 * Release artifacts: the engine binary and the control-plane image, kept in a private S3 bucket of this account
 * (created by the stack, first region only). GitHub Actions write them with short-lived OIDC credentials (one role per
 * repository, one prefix per role); the server reads them with its instance role and checks each one against the
 * SHA-256 given as a stack setting (never against anything stored in the bucket).
 *
 * Object keys (one prefix per writer):
 *   engine/<version>/<arch>/engine                               written by the engine repository (Mircoguidetti/test5)
 *   control-plane/<version>/<arch>/control-plane.tar.gz          written by this repository (docker save | gzip)
 *   boot/                                                       reserved for a boot script too big for user data (not used today)
 * The engine's object is called `engine` whatever the binary is called, so a rename of the binary changes no key: the
 * name lives in ENGINE_BINARY_NAME (lib/engine-command.ts) only.
 */
export const ARTIFACT_PREFIXES = { engine: 'engine/', controlPlane: 'control-plane/', boot: 'boot/' } as const;

export type Arch = 'x86_64' | 'aarch64';

/** A version as the publish workflows write it: <yyyymmdd>-<commit, 12 hex>-r<run number>. Anything safe in a key and a shell word is accepted. */
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function engineKey(version: string, arch: Arch): string {
  return `${ARTIFACT_PREFIXES.engine}${version}/${arch}/engine`;
}

export function controlPlaneKey(version: string, arch: Arch): string {
  return `${ARTIFACT_PREFIXES.controlPlane}${version}/${arch}/control-plane.tar.gz`;
}

/** Repository part of the control-plane image tag, as the publish workflow tags it before `docker save`. */
export const CONTROL_PLANE_IMAGE_REPO = 'fenvix-control-plane';

/** The control-plane image as `docker load` leaves it on the server. */
export function controlPlaneImageRef(version: string): string {
  return `${CONTROL_PLANE_IMAGE_REPO}:${version}`;
}

/** Holds `CONTROL_PLANE_IMAGE=<ref>`: read by the control-plane unit (EnvironmentFile) and by the user script of Step 10. */
export const CONTROL_PLANE_IMAGE_FILE = '/etc/fenvix/control-plane-image';
/** Settings of fenvix-artifact (no secret: bucket name, region, architecture, paths). */
export const ARTIFACTS_ENV_FILE = '/etc/fenvix/artifacts.env';
/** Where every installed engine version stays (the one in use is the target of PATHS.engineBinary). */
export const ENGINE_RELEASES_DIR = '/opt/fenvix/releases/engine';

/** What the server must install at first boot; undefined while the artifacts are not published yet (first deploy). */
export interface ArtifactPins {
  engineVersion: string;
  engineSha256: string;
  controlPlaneVersion: string;
  controlPlaneSha256: string;
}

export function artifactPins(c: FenvixConfig): ArtifactPins | undefined {
  if (c.engineVersion === undefined) return undefined;
  return {
    engineVersion: c.engineVersion,
    engineSha256: c.engineSha256!,
    controlPlaneVersion: c.controlPlaneVersion!,
    controlPlaneSha256: c.controlPlaneSha256!,
  };
}

/** The static part of /etc/fenvix/artifacts.env (the bucket name is added at boot from the user-data header). */
export function artifactsEnv(i: { region: string; artifactsRegion: string; arch: Arch; mongoPort: number }): string[] {
  return [
    `ARTIFACTS_REGION='${i.artifactsRegion}'`,
    `ARCH='${i.arch}'`,
    `ENGINE_LINK='${PATHS.engineBinary}'`,
    `ENGINE_BINARY_NAME='${ENGINE_BINARY_NAME}'`,
    `ENGINE_RELEASES='${ENGINE_RELEASES_DIR}'`,
    `CP_REPO='${CONTROL_PLANE_IMAGE_REPO}'`,
    `CP_IMAGE_FILE='${CONTROL_PLANE_IMAGE_FILE}'`,
    `MONGO_PORT='${i.mongoPort}'`,
  ];
}

/**
 * /usr/local/bin/fenvix-artifact, on the server. Used by the boot script (install) and by an operator through Session
 * Manager (update, rollback). Every download is checked against the SHA-256 given on the command line before anything
 * is replaced; a mismatch stops with a message and leaves the running version alone.
 *
 *   fenvix-artifact install engine|control-plane <version> <sha256>   download, check, make it the current version
 *   fenvix-artifact update  engine|control-plane <version> <sha256>   install + ordered restart + health check; back
 *                                                                      to the previous version if it does not come up
 *   fenvix-artifact rollback engine|control-plane                     back to the previous version + restart
 *   fenvix-artifact current                                            print the versions in use
 *
 * The engine keeps no state on the server (data, WAL and leases are in S3): a restart closes the tenants cleanly on
 * SIGTERM and the new process takes its leases back with the same holder (the instance id). Nothing is lost.
 */
export const ARTIFACT_SCRIPT = String.raw`#!/bin/bash
set -euo pipefail
. /etc/fenvix/artifacts.env
: "${'$'}{HEALTH_TRIES:=36}" "${'$'}{HEALTH_SLEEP:=5}" "${'$'}{HEALTH_STABLE:=20}"
die() { echo "fenvix-artifact: $*" >&2; exit 1; }
say() { echo "fenvix-artifact: $*"; }
kind="${'$'}{2:-}"; ver="${'$'}{3:-}"; want="${'$'}{4:-}"
case "$kind" in engine|control-plane) ;; *) [ "${'$'}{1:-}" = current ] || die "usage: fenvix-artifact install|update|rollback engine|control-plane [version sha256] | current";; esac
checkargs() {
  [[ "$ver" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad version '$ver'"
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "the expected SHA-256 must be 64 lowercase hex characters"
}
fetch() { # key, output file
  aws s3api get-object --region "$ARTIFACTS_REGION" --bucket "$ARTIFACTS_BUCKET" --key "$1" "$2" >/dev/null \
    || die "cannot download s3://$ARTIFACTS_BUCKET/$1 (not published for this version/architecture, or no read access)"
  got="$(sha256sum "$2" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    rm -f "$2"
    die "SHA-256 MISMATCH for $1: expected $want (stack setting), got $got. Nothing installed, nothing started or replaced."
  fi
  say "$1: SHA-256 $got matches"
}
install_engine() {
  local dir="$ENGINE_RELEASES/$ver"
  install -d -m 0755 "$dir"
  fetch "engine/$ver/$ARCH/engine" "$dir/.download"
  chmod 0755 "$dir/.download"; mv -f "$dir/.download" "$dir/$ENGINE_BINARY_NAME"
  local cur; cur="$(readlink "$ENGINE_LINK" || true)"
  if [ -n "$cur" ] && [ "$cur" != "$dir/$ENGINE_BINARY_NAME" ]; then echo "$cur" > "$ENGINE_RELEASES/previous"; fi
  ln -sfn "$dir/$ENGINE_BINARY_NAME" "$ENGINE_LINK.new" && mv -Tf "$ENGINE_LINK.new" "$ENGINE_LINK"
  say "engine $ver is the current version"
}
install_cp() {
  local tar="/var/tmp/fenvix-cp-$ver.tar.gz" ref="$CP_REPO:$ver"
  fetch "control-plane/$ver/$ARCH/control-plane.tar.gz" "$tar"
  docker load -q -i "$tar" >/dev/null || { rm -f "$tar"; die "docker load failed for $tar"; }
  rm -f "$tar"
  docker image inspect "$ref" >/dev/null 2>&1 || die "the archive did not contain the image $ref"
  [ -f "$CP_IMAGE_FILE" ] && cp -f "$CP_IMAGE_FILE" "$CP_IMAGE_FILE.previous"
  echo "CONTROL_PLANE_IMAGE=$ref" > "$CP_IMAGE_FILE.new" && mv -f "$CP_IMAGE_FILE.new" "$CP_IMAGE_FILE"
  say "control plane $ver is the current version"
}
healthy() { # unit; up to 3 min: active, its port (or Docker health check) answers, and no restart for 20 s
  local unit="$1" n0 t
  for t in $(seq 1 "$HEALTH_TRIES"); do
    sleep "$HEALTH_SLEEP"
    systemctl is-active --quiet "$unit" || continue
    if [ "$unit" = fenvix-engine.service ]; then timeout 2 bash -c "</dev/tcp/127.0.0.1/$MONGO_PORT" 2>/dev/null || continue
    else [ "$(docker inspect -f '{{.State.Health.Status}}' fenvix-control-plane 2>/dev/null)" = healthy ] || continue; fi
    n0="$(systemctl show -p NRestarts --value "$unit")"; sleep "$HEALTH_STABLE"
    systemctl is-active --quiet "$unit" && [ "$(systemctl show -p NRestarts --value "$unit")" = "$n0" ] && return 0
  done
  return 1
}
back() {
  if [ "$kind" = engine ]; then
    [ -s "$ENGINE_RELEASES/previous" ] || die "no previous engine version on this server"
    local prev; prev="$(cat "$ENGINE_RELEASES/previous")"; [ -x "$prev" ] || die "previous engine $prev is missing"
    echo "$(readlink "$ENGINE_LINK")" > "$ENGINE_RELEASES/previous"
    ln -sfn "$prev" "$ENGINE_LINK.new" && mv -Tf "$ENGINE_LINK.new" "$ENGINE_LINK"; say "engine back to $prev"
  else
    [ -s "$CP_IMAGE_FILE.previous" ] || die "no previous control-plane version on this server"
    cp -f "$CP_IMAGE_FILE" "$CP_IMAGE_FILE.tmp"; mv -f "$CP_IMAGE_FILE.previous" "$CP_IMAGE_FILE"; mv -f "$CP_IMAGE_FILE.tmp" "$CP_IMAGE_FILE.previous"
    say "control plane back to $(cat "$CP_IMAGE_FILE")"
  fi
}
# Not "a && b || c": set -e does not apply inside a function called from such a list.
doinstall() { if [ "$kind" = engine ]; then install_engine; else install_cp; fi; }
unit() { echo "fenvix-$kind.service"; }
case "${'$'}{1:-}" in
  install) checkargs; doinstall ;;
  update)
    checkargs; doinstall
    say "restarting $(unit) (SIGTERM: the engine closes its tenants cleanly)"; systemctl restart "$(unit)"
    if healthy "$(unit)"; then say "update done: $kind $ver is running"; exit 0; fi
    echo "fenvix-artifact: $kind $ver did not come up healthy: going back to the previous version" >&2
    back; systemctl restart "$(unit)"
    healthy "$(unit)" && die "rolled back: the previous version runs again; $kind $ver is not in use" || die "rolled back, but the previous version is not healthy either: look at journalctl -u $(unit)" ;;
  rollback) back; systemctl restart "$(unit)"; healthy "$(unit)" && say "rollback done" || die "not healthy after rollback: journalctl -u $(unit)" ;;
  current) echo "engine: $(readlink "$ENGINE_LINK" || echo none)"; cat "$CP_IMAGE_FILE" 2>/dev/null || echo "control plane: none" ;;
  *) die "usage: fenvix-artifact install|update|rollback engine|control-plane [version sha256] | current" ;;
esac
`;
