# Customer mode on phoenixNAP: the host side

The founder's guide, the costs and the design are in `docs/CUSTOMER-MODE-PNAP.md`. The control plane (scaler,
placement, host routes) is in `github-app/src/pnap/`; the functions are in `infra/github-app` (`customerMode: pnap`).

| Path | What |
|---|---|
| `host/fenvix_host/` | the host package (Python 3, standard library only): `agent` (enrol once, lease, run, report, drain), `job` (one job start to finish, cleanup on every path), `netplan` (the host's nftables table, each microVM's namespace and rules, the colocated cache's namespace), `vm` (Firecracker configuration, jailer command line), `result` (opening the result disk without following anything, R-012b N1), `read_result` (parser, as fenvix-parse), `post` (summary, as fenvix-post), `config` |
| `host/install-host.sh` | turns a fresh d3.c1.large (Ubuntu 24.04) into a host: KVM check, packages, users, XFS reflink data disk, Firecracker + jailer (SHA-256 checked), the guest kernel and root disk, sysctls, the agent |
| `host/systemd/` | `fenvix-agent.service` (root, `Delegate=yes`), `fenvix-cache.service` (colocated cache, in its own namespace) |
| `guest/` | the guest image build (`build-guest.sh`: Firecracker CI Ubuntu 24.04 + Docker with iptables-legacy + the runner + the engines) and the in-guest job service |
| `cache/install-cache.sh` | the region's dedicated cache server (cache mode "dedicated") |
| `first-test/` | the one-command first real test (`first-test.sh`), its workflow and the in-job probes (`probe.sh`) |
| `bundle.py` | builds the deterministic host bundle the App puts in each server's cloud-init user data (`github-app/src/pnap/host-bundle.generated.ts`); `--check` fails when it is stale |
| `tests/` | `python3 -I -m unittest discover -s tests` (as root for the namespace tests; needs ip, nft, conntrack, unshare, e2fsprogs, jq; node + github-app's node_modules for the Firecracker API check) |

After changing anything under `host/`, `guest/` or `cache/`: `python3 -I bundle.py`, then commit the regenerated file.
