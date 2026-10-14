from __future__ import annotations

import re
from datetime import UTC, datetime

from imagent.gateway import QueuedInputNoticeReason, QueuedInputStatus, QueuedInputStatusKind
from imagent.interaction.messages import (
    ConversationRef,
    OutboundMessage,
    TextContent,
    TextFormat,
)


def queued_input_text(
    status: QueuedInputStatus, *, reason: QueuedInputNoticeReason | None = None
) -> str:
    """Present bounded canonical facts, never native IDs or effect authority."""
    if status.state is QueuedInputStatusKind.UNKNOWN:
        text = (
            "Queue admission is unknown. Zen may have accepted this message. "
            "Check its status before resending; IMZen will not resend it automatically."
        )
    elif status.state is QueuedInputStatusKind.PENDING:
        if reason is QueuedInputNoticeReason.ATTEMPT_FAILED:
            text = (
                "Zen could not start this queued message. It is still pending. "
                "Check the Thread in Zen and use Resume when ready; do not resend the message."
            )
        else:
            text = "Message queued in Zen. It is waiting for a turn; execution has not completed."
    elif status.state is QueuedInputStatusKind.ADMITTED:
        text = "Zen started this message in a turn. This is not confirmation of completion."
    else:
        text = "Queued message cancelled. It will not start a turn."

    # Normal channel IDs are safe in a single Markdown code span and the slash
    # parser. Do not interpolate arbitrary IDs as links, mentions or multiline
    # commands. The authoritative ID remains the unchanged reply target.
    safe_id = re.fullmatch(r"[A-Za-z0-9_./:=+\-]{1,512}", status.message_id)
    target = status.message_id if safe_id else "<original IM message ID>"
    text += f"\nStatus: `/queued {target}`."
    if status.state in {QueuedInputStatusKind.UNKNOWN, QueuedInputStatusKind.PENDING}:
        text += f" Cancel before it starts: `/unqueue {target}`."
    return text


class ImZenQueuedInputPresenter:
    async def present_queued_input(
        self,
        status: QueuedInputStatus,
        *,
        reason: QueuedInputNoticeReason,
        conversation_ref: ConversationRef,
        delivery_id: str,
        reply_to_message_id: str,
    ) -> OutboundMessage:
        return OutboundMessage(
            delivery_id=delivery_id,
            conversation_ref=conversation_ref,
            content=(TextContent(queued_input_text(status, reason=reason), TextFormat.MARKDOWN),),
            created_at=datetime.now(UTC),
            reply_to=reply_to_message_id,
        )
