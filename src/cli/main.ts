#!/usr/bin/env bun

import { errorMessage } from "../shared/errors.js";
import { wirebotVersion } from "../shared/version.js";

const usage = `Usage:
  wirebot start
  wirebot version`;

async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(usage);
    return args.length === 0 ? 1 : 0;
  }

  switch (args[0]) {
    case "start": {
      if (args.length !== 1) throw new Error(usage);
      const { runWirebot } = await import("../index.js");
      await runWirebot();
      return 0;
    }
    case "version": {
      if (args.length !== 1) throw new Error(usage);
      console.log(wirebotVersion);
      return 0;
    }
    default:
      throw new Error(usage);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  },
);
