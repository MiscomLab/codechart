"""A script that edits sys.path: its absolute imports can land anywhere at run time."""

import sys

sys.path.insert(0, "../src")

from shop.billing import charge


def main() -> str:
    return charge(1.0)
