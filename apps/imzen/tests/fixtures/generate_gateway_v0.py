# Single-purpose offline fixture writer; no concurrent application work.
# ruff: noqa: ASYNC230, ASYNC240
"""Generate synthetic v0 state using only the exact original SDK public stores.

Run with an existing v0 Python environment; never installs dependencies or opens
an existing database. The optional second path receives a portable SQLite dump.
"""

import asyncio
import importlib.metadata
import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from imagent.contracts import (
    ApplicationRef,
    ApprovalResponseShape,
    ConversationBinding,
    ConversationDeliveryTarget,
    ConversationRef,
    DeliveryIntent,
    DeliveryReceipt,
    DeliveryReceiptStatus,
    DeliveryRouteSnapshot,
    DeliverySubmissionOrigin,
    DeliverySubmissionRecord,
    DeliverySubmissionState,
    DestinationDeliveryRecord,
    RequestRef,
    RequestRouteCorrelation,
    RequestRouteState,
    TextContent,
    ThreadProjectionRoute,
    ThreadRef,
    ThreadRouteDeliveryTarget,
    TurnReplyCorrelation,
)
from imagent.contracts.delivery import (
    derive_delivery_payload_fingerprint,
    derive_delivery_submission_id,
    derive_delivery_target_fingerprint,
)
from imagent.projections import derive_projection_route_id, derive_turn_reply_correlation_id
from imagent.request_correlations import derive_request_correlation_id
from imagent.storage import SQLiteGatewayState


async def main():
    provenance = json.loads(
        importlib.metadata.distribution("im-agent-sdk").read_text("direct_url.json")
    )
    assert provenance["vcs_info"]["commit_id"] == "bb8055054e4b77b2677682e708dd6f394b56406c"
    assert not Path(sys.argv[1]).exists(), "Refuse to modify an existing database"
    now = datetime(2026, 10, 13, tzinfo=UTC)
    state = SQLiteGatewayState(sys.argv[1])
    thread = ThreadRef("zen-main", "thread-1")
    conversation = ConversationRef("fake-channel", "legacy-chat")
    binding = ConversationBinding(conversation, ApplicationRef("zen-main"), thread_ref=thread)
    await state.put(binding)
    await state.put(binding, expected_revision=1)
    route_id = derive_projection_route_id(thread, conversation)
    await state.put_projection_route(
        ThreadProjectionRoute(
            route_id, thread, conversation, reply_to_message_id="topic", updated_at=now
        )
    )
    await state.advance_projection_checkpoint(
        route_id, expected_agent_item_id=None, agent_item_id="canonical-item-7", checkpointed_at=now
    )
    await state.put_turn_reply_correlation(
        TurnReplyCorrelation(
            derive_turn_reply_correlation_id(thread, "legacy-turn"),
            thread,
            "legacy-turn",
            "input-7",
            conversation,
            "message-7",
            now,
        )
    )
    for status in (RequestRouteState.OPEN, RequestRouteState.RESPONDED):
        request = RequestRef(ApplicationRef("zen-main"), "request-" + status.value)
        await state.put_request_correlation(
            RequestRouteCorrelation(
                derive_request_correlation_id(request, conversation),
                request,
                thread,
                "legacy-turn",
                conversation,
                "request-delivery-" + status.value,
                ApprovalResponseShape(("approve", "deny")),
                status,
                now,
                now,
            )
        )
    for message_id, completed in [("completed-input", True), ("uncertain-input", False)]:
        scope, key = "inbound:fake-channel", "legacy-chat:" + message_id
        await state.claim(scope, key, owner_token="legacy-owner")
        await state.mark_side_effect_started(scope, key, owner_token="legacy-owner")
        if completed:
            await state.complete(scope, key, owner_token="legacy-owner")
    for status in (
        DeliverySubmissionState.UNKNOWN,
        DeliverySubmissionState.ACCEPTED,
        DeliverySubmissionState.IN_FLIGHT,
    ):
        intent = DeliveryIntent(
            "notice-" + status.value,
            ConversationDeliveryTarget(conversation),
            (TextContent("legacy proactive notice"),),
            now,
        )
        origin = DeliverySubmissionOrigin.EXTERNAL
        submission_id = derive_delivery_submission_id(
            origin, "legacy-principal", intent.delivery_id
        )
        receipt = (
            None
            if status == DeliverySubmissionState.IN_FLIGHT
            else DeliveryReceipt(
                DeliveryReceiptStatus.UNKNOWN
                if status == DeliverySubmissionState.UNKNOWN
                else DeliveryReceiptStatus.ACCEPTED_BY_PLATFORM,
                native_message_id=None
                if status == DeliverySubmissionState.UNKNOWN
                else "native-42",
            )
        )
        await state.reserve_delivery_submission(
            DeliverySubmissionRecord(
                submission_id,
                intent.delivery_id,
                origin,
                "legacy-principal",
                derive_delivery_target_fingerprint(intent.target),
                derive_delivery_payload_fingerprint(intent),
                (
                    DestinationDeliveryRecord(
                        submission_id, DeliveryRouteSnapshot(conversation), status, now, receipt
                    ),
                ),
                now,
                now,
            )
        )
    intent = DeliveryIntent(
        "thread-notice",
        ThreadRouteDeliveryTarget(thread, route_id),
        (TextContent("legacy proactive notice"),),
        now,
    )
    origin = DeliverySubmissionOrigin.EXTERNAL
    submission_id = derive_delivery_submission_id(origin, "legacy-principal", intent.delivery_id)
    route = (await state.list_projection_routes(thread_ref=thread))[0]
    await state.reserve_delivery_submission(
        DeliverySubmissionRecord(
            submission_id,
            intent.delivery_id,
            origin,
            "legacy-principal",
            derive_delivery_target_fingerprint(intent.target),
            derive_delivery_payload_fingerprint(intent),
            (
                DestinationDeliveryRecord(
                    submission_id,
                    DeliveryRouteSnapshot(
                        conversation, thread, route_id, route.updated_at, "topic"
                    ),
                    DeliverySubmissionState.UNKNOWN,
                    now,
                    DeliveryReceipt(DeliveryReceiptStatus.UNKNOWN),
                ),
            ),
            now,
            now,
        )
    )
    await state.close()
    if len(sys.argv) > 2:
        with sqlite3.connect(sys.argv[1]) as connection:
            with open(sys.argv[2], "w") as output:
                output.write(
                    "-- Synthetic fixture generated by im-agent-sdk "
                    "bb8055054e4b77b2677682e708dd6f394b56406c.\n"
                )
                output.write("\n".join(connection.iterdump()) + "\n")


asyncio.run(main())
