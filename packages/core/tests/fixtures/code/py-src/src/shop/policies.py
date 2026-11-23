"""Policies, imported relatively from shop.app and from the shop.jobs subpackage."""


def allow(amount: float) -> bool:
    return amount > 0
