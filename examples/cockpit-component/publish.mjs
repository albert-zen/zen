// Host verifies canonical references when displaying the result. This process
// never executes the submitted HTML or maintains component storage.
export function publishComponent(input) {
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 120 ||
    typeof input.html !== "string" ||
    !input.html.trim() ||
    Buffer.byteLength(input.html, "utf8") > 24576 ||
    !Array.isArray(input.sourceItemIds) ||
    input.sourceItemIds.length < 1 ||
    input.sourceItemIds.length > 12 ||
    input.sourceItemIds.some(
      (id) => typeof id !== "string" || !id || id.length > 200,
    )
  )
    throw new Error(
      "Expected a title, HTML up to 24 KiB and 1–12 source Item IDs.",
    );
  return {
    output: `Component saved: ${input.title}. Open it explicitly in Cockpit; source claims require review.`,
    exitCode: 0,
    contentType: "cockpit-component/card",
    structuredContent: {
      version: 1,
      title: input.title,
      html: input.html,
      sourceItemIds: [...input.sourceItemIds],
    },
  };
}
