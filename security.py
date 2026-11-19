"""Password helpers supporting macOS Python builds without hashlib.scrypt."""
import hashlib
import hmac

from werkzeug.security import check_password_hash as _check_password_hash
from werkzeug.security import generate_password_hash as _generate_password_hash


def generate_password_hash(password):
    # PBKDF2 is supported by both Apple's Python and newer Python builds.
    return _generate_password_hash(password, method="pbkdf2:sha256:1000000")


def check_password_hash(saved_hash, password):
    if not saved_hash.startswith("scrypt:") or hasattr(hashlib, "scrypt"):
        return _check_password_hash(saved_hash, password)

    # Keep existing passwords usable without resetting the database.
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    try:
        method, salt, expected = saved_hash.split("$")
        _, n, r, p = method.split(":")
        expected_bytes = bytes.fromhex(expected)
        if not expected_bytes:
            return False
        actual = Scrypt(
            salt=salt.encode(), length=len(expected_bytes),
            n=int(n), r=int(r), p=int(p),
        ).derive(password.encode())
        return hmac.compare_digest(actual, expected_bytes)
    except (ValueError, TypeError):
        return False
