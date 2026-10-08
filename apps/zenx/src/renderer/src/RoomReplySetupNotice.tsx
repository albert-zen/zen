import React from "react";
import { useTranslation } from "react-i18next";
import type { RoomMember } from "../../main/trigger-types.js";

/** Reply configuration is an on-demand section inside conversation settings. */
export function RoomReplySetupNotice({
  members,
  responders,
  configure,
}: {
  members: readonly RoomMember[];
  responders: readonly { name: string; configured: boolean }[];
  configure(member: RoomMember): void;
}) {
  const { t } = useTranslation("panels");
  const unavailable = responders.filter((entry) => !entry.configured);
  return (
    <details className="room-setup-note">
      <summary>
        {t("roomRepliesUnavailableCount", { count: unavailable.length })}
      </summary>
      <div className="room-setup-settings-content">
        <p>{t("roomRepliesUnavailableHelp")}</p>
        <ul>
          {members
            .filter((member) =>
              unavailable.some((entry) => entry.name === member.name),
            )
            .map((member) => (
              <li key={member.threadId}>
                <span>@{member.name}</span>
                <button type="button" onClick={() => configure(member)}>
                  {t("roomMemberReplySettings", { member: member.name })}
                </button>
              </li>
            ))}
        </ul>
      </div>
    </details>
  );
}
