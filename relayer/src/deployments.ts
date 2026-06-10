import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgeDeployments {
  network?: string;
  deployer?: string;
  operator?: string;
  wBLOZ?: string;
  bridge?: string;
  wrapClaim?: string;
  deployedAt?: string;
  claimDeployedAt?: string;
}

export function loadDeployments(): BridgeDeployments | null {
  const candidates = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deployments.json"),
    path.join(process.cwd(), "deployments.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")) as BridgeDeployments;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}
