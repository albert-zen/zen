import type { Reference } from "./composer-selector.js";
import { referenceText } from "./composer-selector.js";
import { normalizeInlineReferences } from "./reference-draft.js";
import { ReferenceToken } from "./ReferenceToken.js";
import { Markdown, type MarkdownInlineToken } from "./Markdown.js";
/** One Markdown parse, with trusted presentation nodes only at validated reference positions. */
export function InlineReferenceContent({
  text,
  references,
  onSource,
}: {
  text: string;
  references: readonly Reference[];
  onSource?(reference: Reference): boolean;
}) {
  const normalized = normalizeInlineReferences(text, references);
  let prefix = "\uE000ZENXREF";
  while (normalized.text.includes(prefix)) prefix += "X";
  let previous = 0;
  let source = "";
  const tokens: MarkdownInlineToken[] = [];
  normalized.references.forEach((reference, index) => {
    const position = reference.position!;
    const marker = `${prefix}${index}\uE001`;
    source += normalized.text.slice(previous, position) + marker;
    previous = position + 1;
    tokens.push({
      marker,
      copyText: referenceText(reference),
      node: (
        <ReferenceToken
          reference={reference}
          onSource={onSource ? () => onSource(reference) : undefined}
        />
      ),
    });
  });
  source += normalized.text.slice(previous);
  return (
    <div className="inline-reference-content">
      <Markdown text={source} inlineTokens={tokens} />
    </div>
  );
}
