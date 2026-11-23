"""Entry points: relative imports and a package re-export."""

from . import billing
from .billing import PaymentService, charge
from .utils import slug as make_slug
from .policies import allow


def run(amount: float) -> str:
    if not allow(amount):
        return ""
    return billing.charge(amount)


def run_service(amount: float) -> str:
    service = PaymentService("app")
    return service.charge(amount)


def run_slug(text: str) -> str:
    return make_slug(text)
