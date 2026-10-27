import { StorageWriterOwnership } from "../src/storage-writer-ownership.js";
const directory = process.argv[2]!;
try {
  const owner = new StorageWriterOwnership(directory, {
    onInitPhase(phase) {
      if (process.argv[3] === phase) process.exit(91);
    },
  });
  process.stdout.write("acquired\n");
  if (process.argv[3] === "hold") {
    process.on("message", () => {
      owner.close();
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  } else owner.close();
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 23;
}
