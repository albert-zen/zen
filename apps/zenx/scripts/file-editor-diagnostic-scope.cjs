/** Explicit test contracts; default retains all assertions. */
exports.fileEditorDiagnosticScope = (args) => {
  if (args.length === 0) return "all";
  if (
    args.length !== 1 ||
    !/^--scope=(all|scroll-security|end-navigation)$/.test(args[0])
  )
    throw new Error(
      "Expected --scope=all, --scope=scroll-security, or --scope=end-navigation",
    );
  return args[0].slice("--scope=".length);
};
