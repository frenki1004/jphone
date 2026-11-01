#!/usr/bin/env python3
"""Tests for tools/push-relay.py. Run: python3 test/push_relay_test.py (needs `cryptography`)."""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("push_relay", os.path.join(HERE, "..", "tools", "push-relay.py"))
pr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pr)
if pr.ec is None:
    print("# skipped: push relay tests need `cryptography`")
    sys.exit(0)

from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

FIXTURE = os.path.join(HERE, "..", "spike", "fixtures", "tool_turn.ndjson")


def priv(b64):
    return ec.derive_private_key(int.from_bytes(pr.unb64u(b64), "big"), ec.SECP256R1())


def decrypt(body, ua_private, auth_secret):
    """Browser side of RFC 8291, written independently of the relay's encrypt()."""
    salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
    as_public = body[21 : 21 + idlen]
    ct = body[21 + idlen :]
    ua_public = pr._point(ua_private.public_key())
    ecdh = ua_private.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
    ikm = pr._hmac(pr._hmac(auth_secret, ecdh), b"WebPush: info\x00" + ua_public + as_public + b"\x01")
    prk = pr._hmac(salt, ikm)
    pt = AESGCM(pr._hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]).decrypt(pr._hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12], ct, None)
    assert pt.endswith(b"\x02") and rs >= len(ct)
    return pt[:-1]


class Crypto(unittest.TestCase):
    def test_rfc8291_vector(self):
        # RFC 8291 section 5 / appendix A, byte for byte.
        body = pr.encrypt(
            b"When I grow up, I want to be a watermelon",
            pr.unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            pr.unb64u("BTBZMqHH6r4Tts7J_aSIgg"),
            as_private=priv("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
            salt=pr.unb64u("DGv6ra1nlYgDCS1FRnbzlw"),
        )
        expected = (
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        )
        self.assertEqual(pr.b64u(body), expected)

    def test_round_trip_with_fresh_keys(self):
        ua = ec.generate_private_key(ec.SECP256R1())
        auth = os.urandom(16)
        msg = json.dumps({"title": "jcode finished", "body": "ünïcode ✓"}).encode()
        self.assertEqual(decrypt(pr.encrypt(msg, pr._point(ua.public_key()), auth), ua, auth), msg)

    def test_rejects_point_off_curve_and_big_payloads(self):
        bad = b"\x04" + b"\x01" * 64
        with self.assertRaises(ValueError):
            pr.encrypt(b"x", bad, os.urandom(16))
        ua = ec.generate_private_key(ec.SECP256R1())
        with self.assertRaises(ValueError):
            pr.encrypt(b"x" * 4000, pr._point(ua.public_key()), os.urandom(16))

    def test_vapid_jwt_verifies(self):
        key = ec.generate_private_key(ec.SECP256R1())
        h = pr.vapid_header("https://web.push.apple.com/abc/def?x=1", key, "mailto:me@example.com", now=1000)
        self.assertTrue(h.startswith("vapid t="))
        jwt, k = h[len("vapid t=") :].split(", k=")
        self.assertEqual(pr.unb64u(k), pr._point(key.public_key()))
        head, claims, sig = jwt.split(".")
        self.assertEqual(json.loads(pr.unb64u(head)), {"typ": "JWT", "alg": "ES256"})
        c = json.loads(pr.unb64u(claims))
        self.assertEqual(c["aud"], "https://web.push.apple.com")
        self.assertEqual(c["exp"], 1000 + 12 * 3600)
        raw = pr.unb64u(sig)
        self.assertEqual(len(raw), 64)
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        key.public_key().verify(der, f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))  # raises if wrong


def events(lines):
    return [json.loads(x) for x in lines if x.strip()]


class Tracker(unittest.TestCase):
    def test_observed_real_turn(self):
        # Exactly what an observer socket saw on a live jcode (see README, push relay).
        evs = [
            {"type": "ack", "id": 1},
            {"type": "done", "id": 1},
            {"type": "session", "session_id": "session_tulip_1"},
            {"type": "done", "id": 1},
            {"type": "peer_user_message", "content": "run sleep"},
            {"type": "tool_start", "id": "t1", "name": "bash"},
            {"type": "text_delta", "text": "Running it."},
            {"type": "tool_done", "id": "t1", "name": "bash", "output": "hi\n"},
            {"type": "message_end", "stop_reason": "tool_use"},
            {"type": "tool_start", "id": "t2", "name": "bash"},
            {"type": "text_delta", "text": "All **done**: "},
            {"type": "text_delta", "text": "pong"},
            {"type": "message_end", "stop_reason": "end_turn"},
            {"type": "done", "id": 2},
            {"type": "done", "id": 0},
        ]
        t = pr.TurnTracker("session_tulip_1793538591219_228c")
        out = [r for r in (t.feed(e, {0, 1, 2}) if e.get("id") in (0, 1) else t.feed(e, {0, 1}) for e in evs) if r]
        self.assertEqual(out, [("finished", "All **done**: pong")])
        self.assertEqual(t.label, "tulip")

    def test_fixture_turn_needs_a_start(self):
        # The recorded fixture is from the sender's socket: no peer_user_message, so no notice.
        with open(FIXTURE) as f:
            evs = events(f)
        t = pr.TurnTracker("session_orangutan_1")
        self.assertEqual([r for r in (t.feed(e, {1}) for e in evs) if r], [])
        # Seen as a peer, the same stream is one finished turn.
        t = pr.TurnTracker("session_orangutan_1")
        out = [r for r in (t.feed(e, {1}) for e in [{"type": "peer_user_message", "content": "x"}] + evs[4:]) if r]
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0][0], "finished")
        self.assertTrue(out[0][1])

    def test_peer_done_with_small_id_is_not_our_ack(self):
        # Live bug: jPhone's first message is request #2, and so was the relay's
        # own `state`. The relay's ids must never collide with a client's.
        t = pr.TurnTracker("session_palmtree_1")
        t.feed({"type": "done", "id": pr.SUB_ID}, pr.OWN_IDS)
        t.feed({"type": "peer_user_message", "content": "x"}, pr.OWN_IDS)
        self.assertEqual(t.feed({"type": "done", "id": 2}, pr.OWN_IDS), ("finished", ""))
        self.assertTrue(all(i > 10**9 for i in pr.OWN_IDS))

    def test_resume_running_turn_via_state(self):
        t = pr.TurnTracker("session_fox_1")
        self.assertIsNone(t.feed({"type": "state", "id": 2, "is_processing": True}, {1, 2}))
        self.assertIsNone(t.feed({"type": "done", "id": 2}, {1, 2}))  # our own state ack
        self.assertEqual(t.feed({"type": "done", "id": 7}, {1, 2}), ("finished", ""))

    def test_interrupt_is_silent_error_is_reported(self):
        t = pr.TurnTracker("session_fox_1")
        t.feed({"type": "peer_user_message", "content": "a"})
        t.feed({"type": "interrupted"})
        self.assertIsNone(t.feed({"type": "done", "id": 4}))
        t.feed({"type": "peer_user_message", "content": "b"})
        self.assertEqual(t.feed({"type": "error", "id": 5, "message": "rate limited"}), ("error", "rate limited"))
        self.assertIsNone(t.feed({"type": "done", "id": 5}))

    def test_rename_sets_label(self):
        t = pr.TurnTracker("session_fox_1")
        t.feed({"type": "session_renamed", "title": "Release prep"})
        self.assertEqual(t.label, "Release prep")
        t.feed({"type": "session_renamed", "title": None})
        self.assertEqual(t.label, "fox")

    def test_notice_hides_content_by_default_shape(self):
        n = pr.notice("finished", "secret ```code``` here", "fox", hide=True)
        self.assertNotIn("secret", json.dumps(n))
        n = pr.notice("finished", "line\n```py\nx=1\n```\n**bold**", "fox", hide=False)
        self.assertEqual(n["title"], "jcode finished · fox")
        self.assertEqual(n["body"], "line [code] bold")
        self.assertEqual(pr.notice("error", "boom", "", hide=False)["title"], "jcode error")
        self.assertEqual(len(pr.notice("finished", "x" * 500, "", hide=False)["body"]), 180)


class RelayLogic(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = pr.Store(os.path.join(self.tmp, "push.json"))
        self.sent = []
        self.status = 201
        self.relay = pr.Relay(self.store, "127.0.0.1", 1, "mailto:t@example.com", sender=lambda sub, p, k, s: (self.sent.append((sub["endpoint"], p)), self.status)[1])
        ua = ec.generate_private_key(ec.SECP256R1())
        self.sub = {"endpoint": "https://push.example/abc", "keys": {"p256dh": pr.b64u(pr._point(ua.public_key())), "auth": pr.b64u(os.urandom(16))}}

    def test_state_file_private_and_key_stable(self):
        self.relay.subscribe("me", self.sub, True)
        mode = os.stat(self.store.path).st_mode & 0o777
        self.assertEqual(mode, 0o600)
        again = pr.Relay(pr.Store(self.store.path), "127.0.0.1", 1, "mailto:x")
        self.assertEqual(again.public_key, self.relay.public_key)
        self.assertEqual(len(pr.unb64u(self.relay.public_key)), 65)

    def test_subscription_validation(self):
        for bad in (None, {}, {**self.sub, "endpoint": "http://insecure/x"}, {**self.sub, "keys": {"p256dh": "AAAA", "auth": self.sub["keys"]["auth"]}}, {**self.sub, "keys": {**self.sub["keys"], "auth": "AAAA"}}):
            with self.assertRaises(ValueError):
                self.relay.subscribe("me", bad, True)

    def test_dispatch_only_to_owner_and_not_while_seen(self):
        self.relay.subscribe("me", self.sub, False)
        other = dict(self.sub, endpoint="https://push.example/other")
        self.relay.subscribe("someone-else", other, False)
        self.assertEqual(self.relay.dispatch({"me"}, "finished", "pong", "fox"), 1)
        self.assertEqual(self.sent[-1], ("https://push.example/abc", {"title": "jcode finished · fox", "body": "pong", "tag": "jphone-fox"}))
        self.relay.seen("me", self.sub["endpoint"], True)
        self.assertEqual(self.relay.dispatch({"me"}, "finished", "pong", "fox"), 0)
        self.relay.seen("me", self.sub["endpoint"], False)
        self.assertEqual(self.relay.dispatch({"me"}, "finished", "pong", "fox"), 1)

    def test_others_cannot_unsubscribe_and_gone_subscriptions_are_dropped(self):
        self.relay.subscribe("me", self.sub, True)
        self.relay.unsubscribe("intruder", self.sub["endpoint"])
        self.assertIn(self.sub["endpoint"], self.store.data["subscriptions"])
        self.status = 410
        self.assertEqual(self.relay.dispatch({"me"}, "finished", "", "fox"), 0)
        self.assertNotIn(self.sub["endpoint"], pr.Store(self.store.path).data["subscriptions"])

    def test_watch_rejects_bad_ids(self):
        for bad in ("", "x", "session_../../etc", "session_" + "a" * 200):
            with self.assertRaises(ValueError):
                self.relay.watch("me", bad)

    def test_token_owner_is_not_the_token(self):
        o = pr.token_owner("secret-token")
        self.assertEqual(len(o), 24)
        self.assertNotIn("secret", o)


if __name__ == "__main__":
    unittest.main(verbosity=1)
