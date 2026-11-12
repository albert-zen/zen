export function packagedProviderSmokeExitCode(failure: unknown): 0 | 1 {
  return failure === undefined ? 0 : 1;
}
