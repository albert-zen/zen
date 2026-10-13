# WinApp downstream build candidate

This is an isolated **build-time experiment**, not an installed or selected ZenX
provider. This checkpoint does not change runtime behavior. The foreground-gate
correction for stock/system WinApp semantic mutations is tracked separately in
[PR #322](https://github.com/albert-zen/zen/pull/322). The official provider archive
lock, capture helper, and app packaging are unchanged here.

## Narrow patch

The source lock pins Microsoft WinApp CLI v0.3.1 at
`c8ada4a403c43b96780b87abc454cba51f649c60`. The patch asks its existing CsWin32
generator for `IUIAutomation2`, sets `AutoSetFocus` to FALSE on the actual service
client, and reads it back before that client is retained. Failure prevents the
service from executing UIA work. No handwritten COM ABI, selector replacement,
focus restoration, input injection, or new runtime fallback is introduced.

The exact private `--zenx-uia-contract` invocation resolves the same registered
service used by semantic actions and reports its live setting, source commit and
explicit downstream identity. Its output does not claim that arbitrary providers
cannot activate themselves. It is evidence about this client, not permission to
relax the separate foreground-safety requirements.

## Build and provenance

The dedicated Windows workflow checks out the exact upstream Git commit, checks
the patch SHA-256 and changed-source preimages, then applies only those reviewed
paths. It uses Node.js 22.23.3 and a job-local .NET install, and requires SDK 10.0.401
and runtime 10.0.12, selected from Microsoft's
[.NET 10 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json).
It builds a self-contained NativeAOT win-x64 candidate, probes the actual feature
contract, and retains the binary, MIT license, patch, lock and provenance as a
same-run CI artifact. The output directory must be fresh; the script never clears
an existing directory. No user-machine SDK installation or runtime compilation
is involved, and no external release or new token is required.

This first checkpoint **captures** NuGet's resolved dependency closure, then uses
locked restore and no-restore publish. The resolved lock and its hash are retained
for review; they are not falsely described as a previously reviewed transitive
pin. Freeze that generated closure before the next production-integration stage.
The hosted Windows image/toolchain is recorded. Bit-identical reproducibility has
not been established; `bitReproducibilityVerified` is explicitly false.

A `provenance.json` appears only after the built executable successfully reports
its exact downstream identity and boolean `autoSetFocus: false`. Other retained
files from a failed workflow are diagnostics, not a validated candidate. The
artifact itself is not yet covered by the app's provider trust anchor and must
not be loaded as a product provider at this checkpoint.

## Validation boundaries

Run the dependency-free contract tests with:

```sh
node --test apps/zenx/test/winapp-downstream-build.test.mjs
```

They exercise actual Git patching and fail-closed source/patch/identity checks.
They do not compile C#, prove the generated interface shape, or execute Windows
UIA. The dedicated native CI must establish those facts. Later checkpoints must
integrate explicit downstream artifact identity/executable hashes into the app's
existing manifest trust chain and test the **real packaged** transport, including
Unicode, button effect, virtual controls, target revalidation, interruption and
unchanged strict capture assertions. Neither default background declarations nor
foreground-overlay integration is included in this build experiment.

Upstream source remains MIT-licensed. The patch's context comes from
[microsoft/winappCli](https://github.com/microsoft/winappCli/tree/c8ada4a403c43b96780b87abc454cba51f649c60);
the build copies the full upstream license beside its output.
