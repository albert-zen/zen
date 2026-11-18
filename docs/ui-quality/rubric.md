# Independent UI review rubric

Evaluate only supplied evidence and the identified implementation. Do not infer
unseen behavior. Record **N/O** (not observed) instead of guessing. A screenshot
can show geometry and visible state, but not prove delivery, persistence,
keyboard behavior, contrast ratios or reduced motion by itself.

For every dimension provide: a 0–4 score, confidence (low/medium/high), image/step
ID, concrete positive and negative evidence, severity, and a falsifiable change
or task that would improve the result. Do not provide an overall vibe score.
Use the same reference pack for every candidate. Do not redefine the scale
relative to the preceding candidate. Compare a baseline and candidate blind
where practical; keep order bias and fixture-data limitations explicit.

## Scoring anchors

- **0 Broken:** the main task is inaccessible, misleading or impossible.
- **1 Weak:** repeated ambiguity or substantial friction; essential cues missing.
- **2 Adequate:** usable, but important inconsistencies or extra work remain.
- **3 Strong:** clear and consistent; small, localized issues remain.
- **4 Exemplary within observed scope:** exceptionally clear and well resolved,
  with concrete evidence and no material issue in the inspected states.

## Dimensions

1. **Information hierarchy and grouping.** Can users distinguish conversation,
   current work, metadata and actions? Are headings, sections, Fork boundaries,
   dividers and disclosure levels meaningful? Identify any two elements that
   compete despite different importance.
2. **Color purpose and semantic accuracy.** Is color consistently tied to action,
   selection, status or identity? Are error/waiting/complete states truthful and
   distinguishable without color alone? Separate measured contrast from visual
   contrast risk. Neutrality is not automatically good; meaningful color counts.
3. **Surface and material consistency.** Do canvas, inset controls, cards,
   floating menus and dialogs form one coherent system? Compare border weight,
   radius, elevation and opacity across equivalent components. Avoid adding
   decoration or monochrome flattening that erases useful distinctions.
4. **Readability and density.** Assess actual text size, line length, line height,
   label clarity, alignment, truncation and content density at tested widths.
   Report concrete unreadable or clipped text, not preference alone.
5. **Attention allocation.** Is the next useful action clear? Do active work and
   action-required states get appropriate prominence without exhausting
   attention? Look for competing chrome, repeated borders, excessive motion,
   empty decoration and metadata louder than content.
6. **Navigation and discoverability.** Can a new user find threads, projects,
   current agent/source, settings sections and the way back? Are context and
   selected states clear? Check whether labels and icons match actual behavior.
7. **Interaction feedback and state integrity.** Distinguish draft, sending,
   accepted, pending, running, failed and uncertain. Check repeated action,
   cancel/back, late response, unsaved changes and unavailable source states.
   Never reward a calm-looking interface that hides failure or uncertainty.
8. **Composition and responsive behavior.** Evaluate alignment, spacing rhythm,
   content widths, viewport containment, narrow layouts and sidebar transitions.
   Identify where reflow or deliberate scrolling is needed rather than clipping.
9. **Accessibility and input robustness.** Check visible focus, keyboard order,
   labels, hit targets, non-color cues and reduced motion. Mark untested assistive
   technology or contrast checks explicitly. No screenshot-only WCAG claims.
10. **Cross-surface consistency and product fit.** Compare chat, sidebar, Fork,
    information cards, models, account, appearance and general settings. Respect
    ZenX's existing semantics and components; do not reward imitation that
    introduces different runtime or product behavior.

## Required output

- Scope / immutable evidence version / limitations.
- Dimension scorecard with the evidence described above.
- Five highest-impact findings, each with severity (P1 blocks task, P2 material
  friction, P3 polish), exact target, trigger, consequence and verification.
- Three specific strengths worth preserving.
- A short prioritized next iteration, and the changes that must not be made.
- For paired reviews, which candidate improves each dimension, unchanged
  problems, new regressions, and evidence that would falsify the preference.

Do not receive or optimize for a target score. Do not copy another review.
