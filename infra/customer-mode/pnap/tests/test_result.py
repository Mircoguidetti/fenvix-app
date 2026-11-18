"""The guest's result disk, read by the host (R-012 F9, R-012b N1): every trick a jail's uid could play with the
file it owns is refused, and the parser accepts only a well-formed, size-capped record."""

import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "host"))
from fenvix_host.read_result import MAX, parse  # noqa: E402
from fenvix_host.result import UnsafeResult, open_result  # noqa: E402

UID = os.geteuid() + 4242 if os.geteuid() == 0 else os.geteuid()
SIZE = 4096


def record(doc):
    body = json.dumps(doc).encode()
    return b"FXRES001" + len(body).to_bytes(4, "big") + body


@unittest.skipUnless(os.geteuid() == 0, "needs root (files owned by a jail uid, root-owned parents)")
class OpenResult(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.chmod(self.tmp, 0o711)
        self.jail = self.make_jail("fxs1-j1")
        self.other = self.make_jail("fxs2-j2")
        with open(f"{self.other}/result.img", "r+b") as f:
            f.write(record({"summary": {"tenant": "other"}}))

    def make_jail(self, name):
        parent = f"{self.tmp}/firecracker/{name}"
        os.makedirs(f"{parent}/root", mode=0o700)
        os.chmod(f"{self.tmp}/firecracker", 0o711)
        os.chown(f"{parent}/root", UID, UID)
        p = f"{parent}/root/result.img"
        with open(p, "wb") as f:
            f.truncate(SIZE)
        os.chown(p, UID, UID)
        return f"{parent}/root"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_a_plain_file_of_the_jail_uid_opens(self):
        fd = open_result(self.jail, UID, size=SIZE)
        os.close(fd)

    def test_a_symlink_to_another_tenants_result_is_refused(self):
        os.remove(f"{self.jail}/result.img")
        os.symlink(f"{self.other}/result.img", f"{self.jail}/result.img")
        with self.assertRaisesRegex(UnsafeResult, "not a plain file"):
            open_result(self.jail, UID, size=SIZE)

    def test_a_hard_link_is_refused(self):
        os.remove(f"{self.jail}/result.img")
        os.link(f"{self.other}/result.img", f"{self.jail}/result.img")
        with self.assertRaisesRegex(UnsafeResult, "2 links"):
            open_result(self.jail, UID, size=SIZE)

    def test_a_fifo_is_refused_without_hanging(self):
        os.remove(f"{self.jail}/result.img")
        os.mkfifo(f"{self.jail}/result.img")
        os.chown(f"{self.jail}/result.img", UID, UID)
        with self.assertRaisesRegex(UnsafeResult, "not a regular file"):
            open_result(self.jail, UID, size=SIZE)

    def test_another_owner_or_size_is_refused(self):
        os.chown(f"{self.jail}/result.img", 0, 0)
        with self.assertRaisesRegex(UnsafeResult, "owned by uid 0"):
            open_result(self.jail, UID, size=SIZE)
        os.chown(f"{self.jail}/result.img", UID, UID)
        os.truncate(f"{self.jail}/result.img", 2 * SIZE)
        with self.assertRaisesRegex(UnsafeResult, "bytes"):
            open_result(self.jail, UID, size=SIZE)

    def test_the_jail_root_replaced_by_a_symlink_is_refused(self):
        parent = os.path.dirname(self.jail)
        os.rename(self.jail, f"{parent}/old")
        os.symlink(self.other, self.jail)
        with self.assertRaisesRegex(UnsafeResult, "jail root"):
            open_result(self.jail, UID, size=SIZE)

    def test_a_parent_that_is_not_root_owned_is_refused(self):
        os.chown(os.path.dirname(self.jail), UID, UID)
        with self.assertRaisesRegex(UnsafeResult, "parent"):
            open_result(self.jail, UID, size=SIZE)


class Parse(unittest.TestCase):
    def test_well_formed(self):
        out = parse(io.BytesIO(record({"summary": {"a": 1}, "t_guest_up": 1.5, "t_job_done": 9, "repositoryId": 666})))
        self.assertEqual(out, {"summary": {"a": 1}, "t_guest_up": 1.5, "t_job_done": 9.0})

    def test_refused(self):
        self.assertEqual(parse(io.BytesIO(b"\0" * 64))["error"], "no result record")
        self.assertIn("refused", parse(io.BytesIO(b"FXRES001" + (MAX + 1).to_bytes(4, "big")))["error"])
        self.assertEqual(parse(io.BytesIO(b"FXRES001" + (10).to_bytes(4, "big") + b"{}"))["error"], "record shorter than its length")
        self.assertEqual(parse(io.BytesIO(b"FXRES001" + (3).to_bytes(4, "big") + b"\xff\xfe\x00"))["error"], "record is not JSON")
        self.assertIsNone(parse(io.BytesIO(record({"summary": "not an object"})))["summary"])


if __name__ == "__main__":
    unittest.main()
