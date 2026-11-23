"""Payment operations."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from .utils import slug
from .utils.text import pad

if TYPE_CHECKING:
    from .models import Receipt

RATE = 0.2


class PaymentService:
    """Charges and refunds."""

    def __init__(self, name: str) -> None:
        self.name = name

    def charge(self, amount: float) -> str:
        return self._format(amount)

    def refund(self, amount: float) -> str:
        self.charge(amount)
        return self._format(-amount)

    def _format(self, amount: float) -> str:
        return pad(slug(self.name), amount)


def charge(amount: float) -> str:
    service = PaymentService("shop")
    return service.charge(amount)


def helper() -> str:
    return os.getcwd()
