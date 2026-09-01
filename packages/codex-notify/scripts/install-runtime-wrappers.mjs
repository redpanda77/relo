#!/usr/bin/env node

import { parseArgs } from "node:util";
import { installRuntimeWrappers } from "../src/runtime-wrappers.mjs";

const values = parseArgs({
  options: {
    node: { type: "string" },
    prefix: { type: "string" },
  },
  strict: true,
}).values;

console.log(JSON.stringify(await installRuntimeWrappers({ node: values.node, prefix: values.prefix })));
