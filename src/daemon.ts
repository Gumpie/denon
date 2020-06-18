// Copyright 2020-present the denosaurs team. All rights reserved. MIT license.

import { log } from "../deps.ts";

import { Denon, DenonEvent } from "../denon.ts";
import { CompleteDenonConfig } from "./config.ts";
import { ScriptOptions } from "./scripts.ts";

/**
 * Daemon instance.
 * Returned by Denon instance when
 * `start(script)` is called. It can be used in a for
 * loop to listen to DenonEvents.
 */
export class Daemon implements AsyncIterable<DenonEvent> {
  #denon: Denon;
  #script: string;
  #config: CompleteDenonConfig;
  #processes: { [pid: number]: Deno.Process } = {};

  constructor(denon: Denon, script: string) {
    this.#denon = denon;
    this.#script = script;
    this.#config = denon.config; // just as a shortcut
  }

  /**
   * Restart current process.
   */
  private async reload(): Promise<void> {
    if (this.#config.logger && this.#config.logger.fullscreen) {
      log.debug("clearing screen");
      console.clear();
    }

    if (this.#config.watcher.match) {
      log.info(`watching path(s): ${this.#config.watcher.match.join(" ")}`);
    }
    if (this.#config.watcher.exts) {
      log.info(`watching extensions: ${this.#config.watcher.exts.join(",")}`);
    }
    log.info("restarting due to changes...");

    this.killAll();

    await this.start();
  }

  private async start(): Promise<ScriptOptions> {
    const commands = this.#denon.runner.build(this.#script);

    // Sequential execution, one process after another is executed,
    // *sequentially*, the last process is named `main` and is the
    // one that will actually be demonized.
    for (let i = 0; i < commands.length; i++) {
      const command = commands[i];
      let process = command.exe();
      log.debug(`S: starting process with pid ${process.pid}`);

      if (i === commands.length - 1) {
        log.warning(`starting main \`${command.cmd.join(" ")}\``);
        this.#processes[process.pid] = process;
        this.monitor(process, command.options);
        return command.options;
      } else {
        log.info(`starting sequential \`${command.cmd.join(" ")}\``);
        await process.status();
      }
    }
    return {};
  }

  private killAll(): void {
    log.debug(`K: killing ${Object.keys(this.#processes).length} process[es]`);
    // kill all processes spawned
    let pcopy = Object.assign({}, this.#processes);
    this.#processes = {};
    for (let id in pcopy) {
      const p = pcopy[id];
      if (Deno.build.os === "windows") {
        log.debug(`K: closing (windows) process with pid ${p.pid}`);
        p.close();
      } else {
        log.debug(`K: killing (unix) process with pid ${p.pid}`);
        Deno.kill(p.pid, Deno.Signal.SIGKILL);
      }
    }
  }

  private async monitor(
    process: Deno.Process,
    options: ScriptOptions,
  ): Promise<void> {
    log.debug(`M: monitoring status of process with pid ${process.pid}`);
    const pid = process.pid;
    let s: Deno.ProcessStatus | undefined;
    try {
      s = await process.status();
      log.debug(`M: got status of process with pid ${process.pid}`);
    } catch (error) {
      log.debug(`M: error getting status of process with pid ${process.pid}`);
    }
    let p = this.#processes[pid];
    if (p) {
      log.debug(`M: process with pid ${process.pid} exited on its own`);
      // process exited on its own, so we should wait a reload
      // remove it from processes array as it is already dead
      delete this.#processes[pid];

      if (s) {
        // log status status
        if (s.success) {
          if (options.watch) {
            log.info("clean exit - waiting for changes before restart");
          } else {
            log.info("clean exit - denon is exiting ...");
          }
        } else {
          if (options.watch) {
            log.error(
              "app crashed - waiting for file changes before starting ...",
            );
          } else {
            log.error("app crashed - denon is exiting ...");
          }
        }
      }
    } else {
      log.debug(`M: process with pid ${process.pid} was killed`);
    }
  }

  private async onExit(): Promise<void> {
    if (Deno.build.os !== "windows") {
      const signs = [
        Deno.Signal.SIGHUP,
        Deno.Signal.SIGINT,
        Deno.Signal.SIGTERM,
        Deno.Signal.SIGTSTP,
      ];
      signs.forEach((s) => {
        (async () => {
          await Deno.signal(s);
          this.killAll();
          Deno.exit(0);
        })();
      });
    }
  }

  async *iterate(): AsyncIterator<DenonEvent> {
    yield {
      type: "start",
    };
    const options = await this.start();
    this.onExit();
    if (options.watch) {
      for await (const watchE of this.#denon.watcher) {
        if (watchE.some((_) => _.type.includes("modify"))) {
          log.debug(
            `R: reload event detected, starting the reload procedure...`,
          );
          yield {
            type: "reload",
            change: watchE,
          };
          await this.reload();
        }
      }
    }
    yield {
      type: "exit",
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<DenonEvent> {
    return this.iterate();
  }
}
