import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { useContext, useEffect, useState } from "react";
import { classifyImageSource } from "../../image-source.js";
import { ImageUrlPreview, ThreadImagesContext } from "./ImagePresentation.js";

export function MarkdownImage({
  source,
  name,
}: {
  source: string;
  name: string;
}) {
  useTranslation("panels");
  const target = classifyImageSource(source);
  const cwd = useContext(ThreadImagesContext)?.cwd;
  const [local, setLocal] = useState<{
    source: string;
    cwd: string | undefined;
    url: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const url =
    target.kind === "url"
      ? target.value
      : local?.source === source && local.cwd === cwd
        ? local.url
        : null;
  useEffect(() => {
    setError(null);
    if (target.kind !== "local") return;
    if (typeof window.zenx?.imageAttachments?.readLocal !== "function") {
      setError("local-reader-unavailable");
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    void window.zenx.imageAttachments
      .readLocal(source, cwd)
      .then(({ bytes, mediaType }) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(
          new Blob([bytes.slice().buffer], { type: mediaType }),
        );
        setLocal({ source, cwd, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [source, cwd]);
  const displayError =
    error === "local-reader-unavailable"
      ? i18n.t("panels:localImageReaderIsUnavailable")
      : error === "image-load-failed"
        ? i18n.t("panels:imageCouldNotBeLoaded")
        : error;
  if (target.kind === "rejected")
    return (
      <span className="image-placeholder">
        {name || i18n.t("panels:unsupportedImage")}
      </span>
    );
  return (
    <>
      <button
        className="image-thumbnail markdown-image"
        type="button"
        aria-label={i18n.t("panels:previewImage", {
          name: name || i18n.t("panels:image"),
        })}
        disabled={url === null || error !== null}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setTrigger(event.currentTarget);
        }}
      >
        {error !== null ? (
          <span role="alert">
            {i18n.t("panels:imageUnavailablePrefix")} {name || source}
          </span>
        ) : url === null ? (
          <span>{i18n.t("panels:loadingImage2")}</span>
        ) : (
          <img
            src={url}
            alt={name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setError("image-load-failed")}
          />
        )}
      </button>
      {trigger === null ? null : (
        <ImageUrlPreview
          url={url}
          error={displayError}
          name={name || i18n.t("panels:image")}
          trigger={trigger}
          onClose={() => setTrigger(null)}
        />
      )}
    </>
  );
}
