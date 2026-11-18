"""Opening a guest's result disk on the host, safely.

The jailer chowns the jail's root directory to the jail's uid, so a Firecracker that escaped its guest (the case the
jailer exists for) can replace result.img with a symlink, a hard link, a FIFO or a device node. A root process that
followed it would parse another tenant's result and post it with this job's credential (R-012b N1). So the host:
  - opens the jail's parent directory (root-owned, made by us), then the jail root and result.img relative to it, each
    with O_NOFOLLOW (a symlink at any of the two last steps fails) and O_NONBLOCK (a FIFO cannot hang us);
  - accepts only a regular file owned by the jail's uid, with one link and exactly the size the host created;
  - hands the open descriptor to the parser, which runs as fenvix-parse and sees only these bytes on stdin.
"""

from __future__ import annotations

import os
import stat


class UnsafeResult(Exception):
    pass


def open_result(jail_root: str, uid: int, name: str = "result.img", size: int | None = None) -> int:
    """A read-only descriptor of <jail_root>/<name>, or UnsafeResult."""
    parent, leaf = os.path.split(jail_root.rstrip("/"))
    if leaf != "root" or "/" in name or name in ("", ".", ".."):
        raise UnsafeResult("unexpected jail layout")
    flags_dir = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    pfd = os.open(parent, flags_dir)
    try:
        pst = os.fstat(pfd)
        if pst.st_uid != 0 or pst.st_mode & 0o022:
            raise UnsafeResult("the jail's parent directory is not root-owned and private")
        try:
            rfd = os.open("root", flags_dir, dir_fd=pfd)
        except OSError as e:
            raise UnsafeResult(f"the jail root is not a plain directory ({e.strerror})") from None
        try:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=rfd)
            except OSError as e:
                raise UnsafeResult(f"{name}: not a plain file ({e.strerror})") from None
            st = os.fstat(fd)
            problem = None
            if not stat.S_ISREG(st.st_mode):
                problem = "not a regular file"
            elif st.st_uid != uid:
                problem = f"owned by uid {st.st_uid}, not the jail's {uid}"
            elif st.st_nlink != 1:
                problem = f"{st.st_nlink} links"
            elif size is not None and st.st_size != size:
                problem = f"{st.st_size} bytes, not {size}"
            if problem:
                os.close(fd)
                raise UnsafeResult(f"{name}: {problem}")
            os.set_blocking(fd, True)
            return fd
        finally:
            os.close(rfd)
    finally:
        os.close(pfd)
