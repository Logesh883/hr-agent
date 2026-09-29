"""What a request means: the structured output of intent parsing (M2).

The model fills in `ModelParse` (intent, entities, confidence, a clarifying question).
Code then decides what's missing: `ParsedRequest.from_model` adds `missing_fields` from the
fixed `REQUIRED_FIELDS` table, so the model can't talk its way past a required field.

Names stay names here ("Rahul", "Engineering"). Turning them into employee and department
ids happens in code against the HR API (A2.4), never by the model.
"""

from datetime import date
from enum import StrEnum
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Intent(StrEnum):
    ONBOARD_EMPLOYEE = "onboard_employee"
    UPDATE_EMPLOYEE = "update_employee"
    FIND_EMPLOYEES = "find_employees"
    REQUEST_LEAVE = "request_leave"
    APPROVE_LEAVE = "approve_leave"
    LEAVE_BALANCE = "leave_balance"
    ATTENDANCE_REVIEW = "attendance_review"
    ATTENDANCE_CORRECTION = "attendance_correction"
    DOCUMENT_STATUS = "document_status"
    POLICY_QUESTION = "policy_question"
    PAYROLL_READINESS = "payroll_readiness"
    UNKNOWN = "unknown"


# One line per intent, for prompts (A2.2) and docs. Keep in step with `Intent`.
INTENT_DESCRIPTIONS: dict[Intent, str] = {
    Intent.ONBOARD_EMPLOYEE: "Add a new hire and start their onboarding.",
    Intent.UPDATE_EMPLOYEE: "Change an employee's job title, department, manager or location.",
    Intent.FIND_EMPLOYEES: "Search or list employees by name, department, manager or location.",
    Intent.REQUEST_LEAVE: "Apply for leave, for the requester or for someone else.",
    Intent.APPROVE_LEAVE: "Approve (or act on) someone's pending leave request.",
    Intent.LEAVE_BALANCE: "How many leave days someone has left.",
    Intent.ATTENDANCE_REVIEW: "Review attendance, anomalies or missing punches.",
    Intent.ATTENDANCE_CORRECTION: "Fix a specific day's attendance record.",
    Intent.DOCUMENT_STATUS: "Which documents are submitted, verified, rejected or missing.",
    Intent.POLICY_QUESTION: "A question answered by HR policy, not by one person's records.",
    Intent.PAYROLL_READINESS: "Whether payroll for a month is ready, and what blocks it.",
    Intent.UNKNOWN: "Not an HR operations request, or too unclear to classify.",
}

# Mirrors LEAVE_TYPES and DOCUMENT_TYPES in packages/contracts, so values pass straight to the API.
LeaveType = Literal["ANNUAL", "SICK", "CASUAL", "UNPAID"]
DocumentType = Literal[
    "OFFER_LETTER",
    "ID_PROOF",
    "ADDRESS_PROOF",
    "PAN_CARD",
    "BANK_DETAILS",
    "EDUCATION_CERTIFICATE",
    "EXPERIENCE_LETTER",
    "PHOTO",
    "OTHER",
]


class _Output(BaseModel):
    # additionalProperties: false, and (with the serialization-mode schema) every field listed
    # as required: what strict structured-output modes demand. Defaults still make Python-side
    # construction short.
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class Entities(_Output):
    """Things the request mentions, as written. Unmentioned fields stay empty."""

    people: list[str] = Field(
        default=[],
        description=(
            "Names of the employees the request is about, exactly as written, e.g. "
            '["Priya"] or ["Sneha Patel", "Arjun"]. Leave empty when the request is about '
            'the requester ("my leave", "I need Friday off"). Never a manager: see manager.'
        ),
    )
    job_title: str | None = Field(default=None, description='e.g. "Software Engineer"')
    department: str | None = Field(default=None, description='Department name, e.g. "Engineering"')
    manager: str | None = Field(
        default=None, description='Name of the manager someone reports to, e.g. "Rahul"'
    )
    location: str | None = Field(default=None, description='Office or city, e.g. "Bangalore"')
    leave_type: LeaveType | None = Field(
        default=None,
        description=(
            "ANNUAL (annual, earned, privilege or vacation leave), SICK, CASUAL, or UNPAID "
            "(including loss of pay / LOP). Null if not stated."
        ),
    )
    document_type: DocumentType | None = Field(
        default=None, description="Which document, if the request names one"
    )
    joining_date: date | None = Field(
        default=None, description="A new hire's first day, as YYYY-MM-DD"
    )
    start_date: date | None = Field(
        default=None,
        description=(
            "First day the request is about (leave, attendance, a payroll month's first day), "
            "as YYYY-MM-DD, worked out from today's date for words like 'next Friday'"
        ),
    )
    end_date: date | None = Field(
        default=None,
        description="Last day of a range, as YYYY-MM-DD. Same as start_date for one day.",
    )

    @model_validator(mode="after")
    def _dates_in_order(self) -> Self:
        # Messages are written for the model: A2.3 sends them back to it to fix its output.
        if self.end_date and not self.start_date:
            raise ValueError("end_date is set but start_date is empty; set both, or neither")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError(f"end_date {self.end_date} is before start_date {self.start_date}")
        return self


class ModelParse(_Output):
    """Exactly what the model is asked to return."""

    intent: Intent
    entities: Entities = Field(default_factory=Entities)
    confidence: float = Field(
        ge=0,
        le=1,
        description="How sure you are of the intent: 1 = certain, below 0.6 = guessing",
    )
    clarifying_question: str | None = Field(
        default=None,
        description=(
            "One short question to the requester when the request is ambiguous or lacks "
            "something needed to act; otherwise null"
        ),
    )

    @classmethod
    def output_schema(cls) -> dict[str, Any]:
        """JSON schema for the model's structured output (all fields required, no extras)."""
        return cls.model_json_schema(mode="serialization")


EntityField = Literal[
    "people",
    "job_title",
    "department",
    "manager",
    "location",
    "leave_type",
    "document_type",
    "joining_date",
    "start_date",
    "end_date",
]

# What each intent needs before the agent can act. Decided here in code, not by the model.
# Deliberately short: a missing department can come from the manager's department, a
# missing end_date means one day, and an empty `people` means the requester (A2.4, M3).
REQUIRED_FIELDS: dict[Intent, tuple[EntityField, ...]] = {
    Intent.ONBOARD_EMPLOYEE: ("people", "job_title", "joining_date", "location"),
    Intent.UPDATE_EMPLOYEE: ("people",),
    Intent.FIND_EMPLOYEES: (),
    Intent.REQUEST_LEAVE: ("leave_type", "start_date"),
    Intent.APPROVE_LEAVE: ("people",),
    Intent.LEAVE_BALANCE: (),
    Intent.ATTENDANCE_REVIEW: (),
    Intent.ATTENDANCE_CORRECTION: ("start_date",),
    Intent.DOCUMENT_STATUS: (),
    Intent.POLICY_QUESTION: (),
    Intent.PAYROLL_READINESS: (),
    Intent.UNKNOWN: (),
}

# Below this the agent asks instead of acting, whatever the model says.
MIN_CONFIDENCE = 0.6


class ParsedRequest(ModelParse):
    """The model's parse plus what code worked out from it."""

    missing_fields: list[EntityField] = []

    @classmethod
    def from_model(cls, parse: ModelParse) -> "ParsedRequest":
        entities = parse.entities
        missing: list[EntityField] = [
            name for name in REQUIRED_FIELDS[parse.intent] if getattr(entities, name) in (None, [])
        ]
        return cls(**parse.model_dump(), missing_fields=missing)

    @property
    def needs_clarification(self) -> bool:
        return (
            self.intent is Intent.UNKNOWN
            or bool(self.missing_fields)
            or self.confidence < MIN_CONFIDENCE
        )
