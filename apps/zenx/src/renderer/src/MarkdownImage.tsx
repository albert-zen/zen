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
      setError("Local image reader is unavailable");
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
  if (target.kind === "rejected")
    return (
      <span className="image-placeholder">{name || "Unsupported image"}</span>
    );
  return (
    <>
      <button
        className="image-thumbnail markdown-image"
        type="button"
        aria-label={`Preview ${name || "image"}`}
        disabled={url === null || error !== null}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setTrigger(event.currentTarget);
        }}
      >
        {error !== null ? (
          <span role="alert">Image unavailable: {name || source}</span>
        ) : url === null ? (
          <span>Loading image…</span>
        ) : (
          <img
            src={url}
            alt={name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setError("Image could not be loaded")}
          />
        )}
      </button>
      {trigger === null ? null : (
        <ImageUrlPreview
          url={url}
          error={error}
          name={name || "Image"}
          trigger={trigger}
          onClose={() => setTrigger(null)}
        />
      )}
    </>
  );
}
