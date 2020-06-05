import { DenonConfig } from "https://deno.land/x/denon@2.1.0/mod.ts";

const config: DenonConfig = {
  scripts: {
    hello: {
      cmd: "echo Hello World from denon.confing.ts",
      desc: "greet the world",
    },
  },
};

export default config;