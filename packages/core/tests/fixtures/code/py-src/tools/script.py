"""A script outside any package: its own folder is its source root, and the src layout is the other."""

import importlib

from shop.billing import charge

billing = importlib.import_module("shop.billing")


def main() -> str:
    return charge(1.0)
