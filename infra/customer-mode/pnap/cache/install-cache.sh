#!/usr/bin/env bash
# The region's shared cache server (cache mode "dedicated"): a small phoenixNAP server (s1.c1.small by default) on the
# region's private network, next to the job hosts. It runs the engine's cache service unchanged (vendored, see
# infra/github-app/lib/cache/PROVENANCE.md) behind fenvix_cache_auth.py: per-job tokens signed by the App, one cache
# organization per customer installation (gh-<installation id>), write only for trusted refs (R-012 F3). It holds
# only the PUBLIC half of the signing key: nothing on it can mint a token. Run once, as root, by its cloud-init user
# data, from /opt/fenvix-host.
#   PRIVATE_CIDR=10.0.0.0/24 bash cache/install-cache.sh      (/etc/fenvix/cache/signing-key.json already written)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${PRIVATE_CIDR:?the region private network, e.g. 10.0.0.0/24}"
[ -s /etc/fenvix/cache/signing-key.json ] || { echo "no signing key" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq python3 nftables iproute2 >/dev/null
id fenvix-cache >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin fenvix-cache
ip_priv="$(python3 -I -c '
import ipaddress, json, subprocess, sys
net = ipaddress.ip_network(sys.argv[1])
for i in json.loads(subprocess.run(["ip", "-j", "-4", "addr"], capture_output=True, text=True).stdout):
    for a in i.get("addr_info", []):
        if ipaddress.ip_address(a["local"]) in net: print(a["local"]); sys.exit(0)
sys.exit(1)' "$PRIVATE_CIDR")"
install -d -m 0755 /opt/fenvix-cache
install -m 0644 "$here/cache_service.py" "$here/fenvix_cache_auth.py" /opt/fenvix-cache/
cat >/etc/systemd/system/fenvix-cache.service <<UNIT
[Unit]
Description=fenvix shared cache of this region (per-job tokens, one organization per customer)
After=network-online.target
Wants=network-online.target
[Service]
User=fenvix-cache
Group=fenvix-cache
ExecStart=/usr/bin/python3 -I /opt/fenvix-cache/fenvix_cache_auth.py serve --data /var/lib/fenvix-cache --key /etc/fenvix/cache/signing-key.json --host $ip_priv --port 8787 --quiet
StateDirectory=fenvix-cache
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
# Inbound: the cache port from the private network only (job hosts masquerade their microVMs to their private
# address), SSH with keys; nothing else.
cat >/etc/nftables.conf <<NFT
#!/usr/sbin/nft -f
flush ruleset
table inet fenvix-cache {
  chain input {
    type filter hook input priority filter; policy drop;
    iifname "lo" accept
    ct state established,related accept
    ip saddr $PRIVATE_CIDR tcp dport 8787 accept
    tcp dport 22 accept
    icmp type echo-request limit rate 5/second accept
  }
}
NFT
systemctl enable --now nftables.service
systemctl daemon-reload && systemctl enable --now fenvix-cache.service
echo "cache ready on $ip_priv:8787"
