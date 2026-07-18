import fs from "fs"
import path from "path"

export function ensureBuildChannel(root: string, env: Record<string, string | undefined>) {
  if (env.MIMOCODE_CHANNEL || env.MIMOCODE_BUMP || env.MIMOCODE_VERSION) return
  if (fs.existsSync(path.join(root, ".git"))) return
  env.MIMOCODE_CHANNEL = "latest"
}
