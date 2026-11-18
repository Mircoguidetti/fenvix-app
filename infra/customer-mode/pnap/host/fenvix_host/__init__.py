"""fenvix customer mode on phoenixNAP Bare Metal Cloud: the host side.

One host (d3.c1.large by default) runs each customer job in its own Firecracker microVM on KVM, under the jailer, in
its own network namespace, with its own disks; everything of the job is deleted after it. Standard library only: the
package is shipped inside the host's cloud-init user data (docs/CUSTOMER-MODE-PNAP.md).

Modules:
  config      the host's settings (from the App at enrolment) and their checks
  netplan     the host's nftables ruleset, each microVM's network namespace and its ruleset
  vm          each job's Firecracker configuration and jailer command line (cgroups, seccomp, uid, chroot)
  result      opening a guest's result disk without following anything the jail's uid could plant (R-012b N1)
  read_result the result parser (runs as fenvix-parse; bytes on stdin only)
  post        the summary sender (runs as fenvix-post; holds the job's own summary credential only)
  job         one job, start to finish, with cleanup on every path
  agent       the loop: enrol once, lease jobs for free slots, run them, report, drain
"""

__version__ = "0.1.0"
