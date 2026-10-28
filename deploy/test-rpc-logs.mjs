#!/usr/bin/env node
import { createPublicClient, http, parseAbi } from "viem";
import { bsc } from "viem/chains";
const bridge = "0xA7f3bEe62b20F041358062d890eF60b4E12464b7";
const abi = parseAbi([
  "event UnwrapRequested(uint256 indexed unwrapId, address indexed user, uint256 amount, string bz1Address)",
]);
const url = process.argv[2] ?? "https://bsc.publicnode.com";
const block = BigInt(process.argv[3] ?? "107226501");
const c = createPublicClient({ chain: bsc, transport: http(url) });
const logs = await c.getLogs({
  address: bridge,
  event: abi[0],
  fromBlock: block,
  toBlock: block,
});
console.log(url, "block", block.toString(), "logs", logs.length);
