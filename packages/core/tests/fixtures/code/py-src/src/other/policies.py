"""Policies, imported by `shop.app` with a relative path two levels up."""


def allow(amount: float) -> bool:
    return amount > 0
