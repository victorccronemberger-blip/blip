import { ZipReader, Uint8ArrayReader } from "@zip.js/zip.js"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

const created: string[] = []

async function createPentesterCodeBundle(dir: string) {
  const root = path.join(dir, "packages", "pentestercode")
  const files = {
    "mimocode.defaults.jsonc":
      '{"default_agent":"pentester","mcp":{"bugcrowd":{"command":["bun","__MIMOCODE_HOME__/vendor/pentesterflow/bugcrowd-mcp.ts"]}}}',
    "fusion/fusion-mcp.ts": "console.log('fusion')",
    "vendor/pentdem/requirements.txt": "httpx\n",
    "vendor/pentesterflow/bugcrowd-mcp.ts": "console.log('bugcrowd')",
    "vendor/pentesterflow/intigriti-mcp.ts": "console.log('intigriti')",
    "vendor/pentesterflow/hackerone-mcp.ts": "console.log('hackerone')",
    "vendor/pentesterflow/pentestercode-mcp.ts": "console.log('core')",
    "vendor/pentesterflow/src/browser/mcpServer.ts": "console.log('burp')",
    "vendor/pentesterflow/src/this/is/a/deliberately/long/runtime/path/that/exceeds/the/classic/tar/name/limit/mcp.ts":
      "console.log('pentesterflow')",
    "script/seed-home.ts": "console.log('seed')",
    "script/seed-home.ps1":
      "New-Item -ItemType Directory -Force -Path $env:MIMOCODE_HOME | Out-Null; Set-Content -Path (Join-Path $env:MIMOCODE_HOME 'seeded.txt') -Value seeded",
    "POST-INSTALL.md": "# Post install",
    ".env": "API_KEY=must-not-ship",
    "vendor/pentdem/node_modules/private/index.js": "must-not-ship",
    "vendor/pentdem/__pycache__/cache.pyc": "must-not-ship",
    "reports/engagement.json": "must-not-ship",
    "test/runtime.test.ts": "must-not-ship",
    "vendor/pentesterflow/src/runtime.test.ts": "must-not-ship",
    "vendor/pentdem/test_pipeline.py": "must-not-ship",
  }
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await Bun.write(path.join(root, name), content)
    }),
  )
  return root
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })))
})

describe("installer packaging", () => {
  test("tracks every source required by the native build and bundled MCP runtimes", async () => {
    const root = path.resolve(import.meta.dir, "../../../..")
    if (!(await Bun.file(path.join(root, ".git", "HEAD")).exists())) return
    const required = [
      "packages/opencode/script/build-environment.ts",
      "packages/opencode/script/build-node.ts",
      "packages/pentestercode/vendor/pentesterflow/src/target/target.ts",
    ]

    expect(
      required.filter(
        (file) => Bun.spawnSync(["git", "ls-files", "--error-unmatch", file], { cwd: root }).exitCode !== 0,
      ),
    ).toEqual([])
  })

  test("Linux source installer reuses valid dependencies and repairs invalid dependencies before building", async () => {
    const script = await Bun.file(path.resolve(import.meta.dir, "../../../..", "install-linux.sh")).text()

    expect(script.indexOf("bun add --global node-gyp@12.3.0")).toBeLessThan(
      script.indexOf("bun install --frozen-lockfile"),
    )
    expect(script).toContain("if ! (\n  cd \"$REPOSITORY_DIR\"\n  bun install --frozen-lockfile")
    expect(script.indexOf("bun install --frozen-lockfile")).toBeLessThan(
      script.indexOf('rm -rf -- "$REPOSITORY_DIR/node_modules"'),
    )
    expect(script).toContain('rm -rf -- "$REPOSITORY_DIR/node_modules"')
    expect(script).toContain('rev-parse --show-toplevel')
    expect(script).toContain("--stash-local-changes")
    expect(script).toContain("stash push --include-untracked")
    expect(script).toContain('LOCAL_CHANGES_STASH="$(git -C "$REPOSITORY_DIR" rev-parse refs/stash)"')
    expect(script).toContain("Verified Bugcrowd, Intigriti and HackerOne MCP installation")
    expect(script).toContain('$HOME/.mimocode/runtime/$platform-mcp.js')
    expect(script).toContain("sha256sum -c -")
    expect(script).toContain('backup="$config.backup-')
    expect(script).not.toMatch(/(INTIGRITI_TOKEN|HACKERONE_API_TOKEN)="[^.]{8,}"/)
  })

  test("packages a Windows binary with its offline installer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-package-"))
    created.push(dir)
    const binary = path.join(dir, "input", "mimo.exe")
    const installer = path.join(dir, "install.ps1")
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await Bun.write(binary, "windows-binary")
    await Bun.write(installer, "# windows installer")
    const bundleDir = await createPentesterCodeBundle(dir)
    const { packageTarget } = await import("../../script/package-installers")

    const output = await packageTarget({
      target: "mimocode-windows-x64",
      binary,
      installer,
      outputDir: dir,
      bundleDir,
    })
    const reader = new ZipReader(new Uint8ArrayReader(await Bun.file(output).bytes()))
    const entries = await reader.getEntries()
    await reader.close()

    expect(path.basename(output)).toBe("mimocode-windows-x64.zip")
    expect(entries.map((entry) => entry.filename)).toContain("packages/pentestercode/fusion/fusion-mcp.ts")
    expect(entries.map((entry) => entry.filename)).toContain("packages/pentestercode/vendor/pentdem/requirements.txt")
    expect(entries.map((entry) => entry.filename)).toContain(
      "packages/pentestercode/vendor/pentesterflow/bugcrowd-mcp.ts",
    )
    expect(entries.map((entry) => entry.filename)).toContain("packages/pentestercode/runtime/bugcrowd-mcp.js")
    expect(entries.map((entry) => entry.filename)).toContain("README-PENTESTERCODE.md")
    expect(entries.map((entry) => entry.filename)).not.toContain("packages/pentestercode/.env")
    expect(entries.map((entry) => entry.filename).some((entry) => entry.includes("node_modules"))).toBe(false)
    expect(entries.map((entry) => entry.filename).some((entry) => entry.includes("__pycache__"))).toBe(false)
    expect(entries.map((entry) => entry.filename).some((entry) => entry.includes("reports/"))).toBe(false)
    expect(entries.map((entry) => entry.filename).some((entry) => entry.includes("/test/"))).toBe(false)
    expect(entries.map((entry) => entry.filename).some((entry) => entry.includes(".test."))).toBe(false)
    expect(entries.map((entry) => entry.filename).some((entry) => path.basename(entry).startsWith("test_"))).toBe(false)
    expect(entries.map((entry) => entry.filename)).toContain("install.ps1")
    expect(entries.map((entry) => entry.filename)).toContain("mimo.exe")
  })

  test("packages a Linux binary with its offline installer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-package-"))
    created.push(dir)
    const binary = path.join(dir, "input", "mimo")
    const installer = path.join(dir, "install")
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await Bun.write(binary, "linux-binary")
    await Bun.write(installer, "#!/usr/bin/env bash")
    const bundleDir = await createPentesterCodeBundle(dir)
    const { packageTarget } = await import("../../script/package-installers")

    const output = await packageTarget({
      target: "mimocode-linux-x64",
      binary,
      installer,
      outputDir: dir,
      bundleDir,
    })
    const listing = await new Response(Bun.spawn(["tar", "-tzvf", output]).stdout).text()
    const entries = listing
      .trim()
      .split(/\r?\n/)
      .map((line) => ({ mode: line.split(/\s+/)[0], name: line.split(/\s+/).at(-1)! }))

    expect(path.basename(output)).toBe("mimocode-linux-x64.tar.gz")
    expect(entries.map((entry) => entry.name)).toContain("packages/pentestercode/fusion/fusion-mcp.ts")
    expect(entries.map((entry) => entry.name)).toContain("packages/pentestercode/vendor/pentdem/requirements.txt")
    expect(entries.map((entry) => entry.name)).toContain(
      "packages/pentestercode/vendor/pentesterflow/bugcrowd-mcp.ts",
    )
    expect(entries.map((entry) => entry.name)).toContain("packages/pentestercode/runtime/bugcrowd-mcp.js")
    const config = await new Response(
      Bun.spawn(["tar", "-xOzf", output, "packages/pentestercode/mimocode.defaults.jsonc"]).stdout,
    ).text()
    expect(config).toContain("runtime/bugcrowd-mcp.js")
    expect(config).not.toContain("vendor/pentesterflow/bugcrowd-mcp.ts")
    expect(entries.map((entry) => entry.name).some((entry) => entry.length > 100)).toBe(true)
    expect(entries.map((entry) => entry.name)).toContain("README-PENTESTERCODE.md")
    expect(entries.map((entry) => entry.name)).not.toContain("packages/pentestercode/.env")
    expect(entries.map((entry) => entry.name).some((entry) => entry.includes("node_modules"))).toBe(false)
    expect(entries.map((entry) => entry.name).some((entry) => entry.includes("__pycache__"))).toBe(false)
    expect(entries.map((entry) => entry.name).some((entry) => entry.includes("reports/"))).toBe(false)
    expect(entries.map((entry) => entry.name).some((entry) => entry.includes("/test/"))).toBe(false)
    expect(entries.map((entry) => entry.name).some((entry) => entry.includes(".test."))).toBe(false)
    expect(entries.map((entry) => entry.name).some((entry) => path.basename(entry).startsWith("test_"))).toBe(false)
    expect(entries.filter((entry) => ["mimo", "install"].includes(entry.name)).every((entry) => entry.mode === "-rwxr-xr-x")).toBe(
      true,
    )
  })

  test("Windows installer accepts an offline binary", async () => {
    if (process.platform !== "win32") return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-install-"))
    created.push(dir)
    const binary = path.join(dir, "mimo-source.exe")
    const installDir = path.join(dir, "installed")
    await Bun.write(binary, "offline-windows-binary")
    const subprocess = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve(import.meta.dir, "../../../..", "install.ps1"),
        "-Binary",
        binary,
        "-NoModifyPath",
      ],
      {
        env: { ...Bun.env, MIMOCODE_INSTALL_DIR: installDir, MIMO_FDS_BASE: "http://127.0.0.1:1" },
        stdout: "ignore",
        stderr: "pipe",
      },
    )

    expect(await subprocess.exited).toBe(0)
    expect(await Bun.file(path.join(installDir, "mimo.exe")).text()).toBe("offline-windows-binary")
  })

  test("Windows offline installer seeds its bundled PentesterCode runtime", async () => {
    if (process.platform !== "win32") return
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-seeded-install-"))
    created.push(dir)
    const binary = path.join(dir, "input", "mimo.exe")
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await Bun.write(binary, "offline-windows-binary")
    const { packageTarget } = await import("../../script/package-installers")
    const archive = await packageTarget({
      target: "mimocode-windows-x64",
      binary,
      installer: path.resolve(import.meta.dir, "../../../..", "install.ps1"),
      outputDir: dir,
      bundleDir: await createPentesterCodeBundle(dir),
    })
    const extracted = path.join(dir, "extracted")
    const expand = Bun.spawn(
      ["powershell", "-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", archive, "-DestinationPath", extracted],
      { stdout: "ignore", stderr: "pipe" },
    )
    expect(await expand.exited).toBe(0)
    const home = path.join(dir, "home")
    const subprocess = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(extracted, "install.ps1"),
        "-Binary",
        path.join(extracted, "mimo.exe"),
        "-NoModifyPath",
      ],
      {
        env: {
          ...Bun.env,
          MIMOCODE_HOME: home,
          MIMOCODE_INSTALL_DIR: path.join(dir, "installed"),
          MIMOCODE_SKIP_DEPENDENCY_CHECK: "1",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    )

    expect(await subprocess.exited).toBe(0)
    expect(await Bun.file(path.join(home, "seeded.txt")).text()).toContain("seeded")
  })

  test("packages every built Windows and Linux target", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-builds-"))
    created.push(dir)
    const targets = ["mimocode-windows-x64", "mimocode-linux-x64"]
    await Promise.all(
      targets.map(async (target) => {
        const binary = path.join(dir, "dist", target, "bin", target.includes("windows") ? "mimo.exe" : "mimo")
        await fs.mkdir(path.dirname(binary), { recursive: true })
        await Bun.write(binary, target)
      }),
    )
    await Bun.write(path.join(dir, "install.ps1"), "# windows installer")
    await Bun.write(path.join(dir, "install"), "#!/usr/bin/env bash")
    const { packageBuiltTargets } = await import("../../script/package-installers")

    const outputs = await packageBuiltTargets({ targets, distDir: path.join(dir, "dist"), projectRoot: dir })

    expect(outputs.map((item) => path.basename(item)).sort()).toEqual([
      "mimocode-linux-x64.tar.gz",
      "mimocode-windows-x64.zip",
    ])
    expect(await Bun.file(path.join(dir, "dist", "SHA256SUMS-linux.txt")).text()).toMatch(
      /^[0-9a-f]{64}  mimocode-linux-x64\.tar\.gz\n$/,
    )
    const guide = await Bun.file(path.join(dir, "dist", "INSTALL-LINUX.txt")).text()
    expect(guide).toContain("cd /diretorio/onde/os-arquivos-foram-copiados")
    expect(guide).toContain("./install --binary ./mimo")
    expect(guide).toContain('export PATH="$HOME/.mimocode/bin:$PATH"')
    expect(guide).not.toContain("source ~/.bashrc")
  })

  test("uses a deterministic build channel outside a Git checkout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-source-"))
    created.push(dir)
    const env: Record<string, string | undefined> = {}
    const { ensureBuildChannel } = await import("../../script/build-environment")

    ensureBuildChannel(dir, env)

    expect(env.MIMOCODE_CHANNEL).toBe("latest")
  })
})
