#!/usr/bin/env node
import { main } from "../cli/kernel.mjs";
import { spec } from "../cli/spec.mjs";
await main(spec);
