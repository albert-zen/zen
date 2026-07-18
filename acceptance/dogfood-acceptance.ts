/**
 * APP-005C replaces the single-project dogfood route. The previous acceptance
 * suite remains as a skipped historical fixture until APP-006 supplies the
 * browser harness; its test imports these placeholders but it is not part of
 * the APP-005C targeted run.
 */
export async function runDogfoodAcceptanceScenario(
  _input: Record<string, unknown> & {
    readonly createAppServer?: (input: { readonly fixturePath: string }) => unknown;
  }
): Promise<{ readonly status: string; readonly fixturePath: string }> {
  return {
    status: 'skipped',
    fixturePath: '',
  };
}

export function summarizeDogfoodAcceptanceThread(_input: unknown): string {
  return 'Superseded by Agent App project bootstrap acceptance';
}
