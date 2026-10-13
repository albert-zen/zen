# ZenX Windows UIA downstream provider

`zenx-winapp-uia` is the explicitly identified, build-time downstream of Microsoft
WinApp CLI v0.3.1 (`c8ada4a403c43b96780b87abc454cba51f649c60`). Its build identity is
`zenx-winapp-0.3.1-af0.2`, version `0.3.1-zenx.af0.2`, strict contract version 1.
It is shipped separately from the unchanged official `microsoft-winapp-cli` npm
archive and the system provider route. No native compilation occurs at runtime.

## Reviewed inputs

`source.lock.json` fixes the upstream commit, changed-file Git preimages, new-file
absence, patch digest, toolchain, target RID and reviewed NuGet dependency lock.
Git attributes preserve the patch and source-lock LF bytes and the dependency
lock's original CRLF bytes. The frozen `packages.lock.json` is the actual reviewed
CI closure: 13,704 bytes, SHA-256
`33e2b9b7fad15c4b582be384306f769ead57ac17cfc598672c3d361a54e4860a`.
It is copied into the clean, verified source checkout **before the first restore**.
Only `dotnet restore --locked-mode` and `publish --no-restore` are allowed; raw lock
bytes are compared again after each command.

The native build uses Node.js 22.23.3, a job-local .NET SDK 10.0.401, .NET runtime
10.0.12 and `win-x64`. Release/RID/self-contained properties are identical for
MSBuild evaluation, restore and publish. `ProcessFrameworkReferences` must resolve
the expected target framework, .NET runtime and RID-specific runtime pack both
before and after restore. Both readbacks and SDK information are retained. A
global `RuntimeFrameworkVersion` override is deliberately avoided because it also
changes the unrelated Windows SDK framework.

## Native contract

The patch obtains generated `IUIAutomation2`, sets `AutoSetFocus` to FALSE and
reads it back on the actual service client before retaining it. The private
`--zenx-uia-contract` probe must emit the exact schema/build/source identity,
`contractVersion: 1` and boolean `autoSetFocus: false`. The strict command uses this
client and its bounded request/response contract. These checks do not promise
that an arbitrary application's own UIA provider cannot activate that application.

## Same-run build and assembly handoff

The Windows packaged-provider CI job builds the candidate once in a fresh output
directory. The same staging input and the SHA-256 of its raw `provenance.json`
are passed explicitly to both smoke and real app packaging:

```sh
node scripts/build-zenx-winapp-downstream.mjs --source SOURCE --output CANDIDATE
node apps/zenx/scripts/package-zenx-portable.mjs --app --downstream CANDIDATE --downstream-sha256 PROVENANCE_SHA256
```

The producer emits `provenanceSha256` in JSON and the `provenance-sha256` GitHub
step output. Windows packaging requires both arguments. It does not look up or
download a binary from a different workflow run. The separate native-review
workflow is manual-only; its retained files are review evidence, not an automatic
product input. macOS and Linux packaging remain unchanged.

Assembly first checks the externally supplied provenance digest, exact reviewed
source-lock/patch/dependency-lock bytes, identity, strict contract, SDK/runtime
facts, both runtime readbacks and every shipped file's size and SHA-256. It rejects
missing files, extra files/directories, links and unsafe paths. It copies to a
fresh provider directory and revalidates the copy before generating the manifest.
This is a coupling within the trusted app-build boundary: hashes alone do not
prove that an arbitrary binary was compiled from its claimed source.

The `zenx-winapp-uia` manifest entry invokes `bin/winapp.exe` directly with no Node
runtime. It seals the complete `bin` directory without ignored paths, separately
lists every binary file (including `winapp.exe` and `libSkiaSharp.dll`), and covers
provenance, source lock, frozen NuGet lock, patch, upstream license, SDK details
and runtime evidence. Its `downstream` metadata is derived from validated inputs.
The existing compiled final-manifest SHA-256 injection remains the sole product
trust anchor; provenance does not create a second authority.

Provenance names and hashes every other shipped file and enumerates directories.
Its own digest comes from the trusted build handoff and is then sealed as a
manifest asset. The runner image/toolchain are recorded.
`bitReproducibilityVerified` remains false: bit-identical NativeAOT outputs have
not been established. Native build success also does not stand in for product UIA
acceptance; `productIntegrationVerified` remains false in build provenance.

## Validation boundaries

Dependency-free tests exercise source patching, raw-byte preservation through a
Windows-style Git clone, frozen closure/runtime constraints, strict identity and
assembly tamper rejection:

```sh
node --test apps/zenx/test/winapp-downstream-build.test.mjs apps/zenx/test/winapp-downstream-assembly.test.mjs
```

These tests do not compile C#, prove generated COM interface shape or execute
Windows UIA. Windows CI must establish native compilation and probe validity;
packaged acceptance must exercise real transport and effects, target revalidation,
Unicode, virtual controls, interruption and unchanged strict capture guarantees.
No external release publication, persistent credentials or user-machine SDK
installation is required.

Upstream source remains MIT-licensed. The patch context comes from
[microsoft/winappCli](https://github.com/microsoft/winappCli/tree/c8ada4a403c43b96780b87abc454cba51f649c60);
the build copies its full license into the shipped provider directory.
