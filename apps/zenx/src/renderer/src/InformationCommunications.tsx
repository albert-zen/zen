import React from "react";
import { useTranslation } from "react-i18next";
import {
  MessageSourceLink,
  MessageSourceViewportContext,
} from "./message-source-navigation.js";
import type { InformationCommunications as Projection } from "./information-communications.js";

/** Native wrapper only: message excerpts never enter generic plugin context. */
export function InformationCommunications({
  ownerThreadId,
  projection,
}: {
  ownerThreadId: string;
  projection?: Projection;
}) {
  const { t } = useTranslation("panels");
  if (
    projection?.ownerThreadId !== ownerThreadId ||
    !projection.messages.length
  )
    return null;
  return (
    <MessageSourceViewportContext.Provider value={ownerThreadId}>
      <div className="information-communications">
        <h4>{t("informationReceivedAgents")}</h4>
        <p className="information-communications-scope">
          {t("informationReceivedLoaded")}
        </p>
        <ul>
          {projection.messages.map((message) => (
            <li key={message.id}>
              <MessageSourceLink
                target={{
                  kind: "thread",
                  id: message.senderThreadId,
                  sourceTool: message.sourceTool,
                }}
                label={t("informationReceivedSource", {
                  name: message.senderName ?? t("informationUnnamedAgent"),
                })}
              />
              {message.excerpt ? (
                <p className="information-communications-excerpt">
                  {message.excerpt}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </MessageSourceViewportContext.Provider>
  );
}
