// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2023-Present The Pepr Authors

import { Command } from "commander";
import { Log } from "../lib";

export class RootCmd extends Command {
  createCommand(name: string) {
    const cmd = new Command(name);

    cmd.option(
      "-l, --log-level [level]",
      "Log level: debug, info, warn, error",
      "info"
    );
    cmd.option("-d, --dir [directory]", "Pepr module directory", ".");

    cmd.hook("preAction", run => {
      Log.SetLogLevel(run.opts().logLevel);
    });

    return cmd;
  }
}