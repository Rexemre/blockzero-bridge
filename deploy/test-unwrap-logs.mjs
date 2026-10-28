#!/usr/bin/env node
import { fetchUnwrapEvents } from "../relayer/dist/bsc.js";
const from = BigInt(process.argv[2] ?? "107226501");
const res = await fetchUnwrapEvents(from);
const events = Array.isArray(res) ? res : res.events;
console.log("from", from.toString(), "events", events.length);
