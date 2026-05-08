#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const trace = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "copilot-cli-trace.bin"));
process.stdout.write(trace);
process.stdin.resume();
