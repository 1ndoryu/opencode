import { $ } from "bun"
import { join } from "node:path"
import { downloadCliToResources } from "./utils"

// Workspace root owns node_modules; predev runs from packages/desktop.
const root = join(import.meta.dir, "..", "..")

async function installElectron() {
  await $`bun run install-electron`
}

try {
  await installElectron()
} catch {
  // Isolated installs can lose links (seen: electron without its
  // @electron/get dep after external churn on node_modules). Repair once
  // from the lockfile, then retry a single time instead of failing.
  console.warn("[predev] install-electron failed, repairing dependencies with bun install and retrying once…")
  await $`bun install`.cwd(root)
  await installElectron()
}

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`
await downloadCliToResources()
