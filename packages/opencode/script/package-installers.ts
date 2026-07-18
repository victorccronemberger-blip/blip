import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import fs from "fs/promises"
import path from "path"
import { gzipSync } from "zlib"

const TAR_BLOCK_SIZE = 512
const TAR_TIMESTAMP = 946684800 // 2000-01-01T00:00:00Z, stable and human-readable
const BUNDLE_PREFIX = "packages/pentestercode"
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  "_smoke",
  "reports",
  ".sessions",
  ".memory",
  "test",
  "tests",
])
const EXCLUDED_DOCS = new Set(["PROMPT-PACKAGER-AI.md", "INSTALLER.md", "docs/HANDOFF-REBUILD-OPEN-HARNESS.md"])
const MCP_RUNTIME_ENTRYPOINTS = [
  ["pentesterflow-core.js", "vendor/pentesterflow/pentestercode-mcp.ts"],
  ["pentesterflow-burp.js", "vendor/pentesterflow/src/browser/mcpServer.ts"],
  ["bugcrowd-mcp.js", "vendor/pentesterflow/bugcrowd-mcp.ts"],
  ["intigriti-mcp.js", "vendor/pentesterflow/intigriti-mcp.ts"],
  ["hackerone-mcp.js", "vendor/pentesterflow/hackerone-mcp.ts"],
  ["pentestercode-fusion.js", "fusion/fusion-mcp.ts"],
] as const

type ArchiveEntry = {
  name: string
  content: Uint8Array
  mode: number
}

function tarField(header: Uint8Array, offset: number, length: number, value: string) {
  header.set(new TextEncoder().encode(value).slice(0, length), offset)
}

function tarOctal(header: Uint8Array, offset: number, length: number, value: number) {
  tarField(header, offset, length, value.toString(8).padStart(length - 1, "0") + "\0")
}

function tarPath(name: string) {
  if (new TextEncoder().encode(name).length <= 100) return { name, prefix: "" }
  const split = [...name.matchAll(/\//g)]
    .map((match) => match.index)
    .reverse()
    .find(
      (index) =>
        new TextEncoder().encode(name.slice(0, index)).length <= 155 &&
        new TextEncoder().encode(name.slice(index + 1)).length <= 100,
    )
  if (split === undefined) throw new Error(`Path exceeds USTAR limits: ${name}`)
  return { name: name.slice(split + 1), prefix: name.slice(0, split) }
}

function tarEntry(entry: ArchiveEntry) {
  const header = new Uint8Array(TAR_BLOCK_SIZE)
  const name = tarPath(entry.name)
  tarField(header, 0, 100, name.name)
  tarOctal(header, 100, 8, entry.mode)
  tarOctal(header, 108, 8, 0)
  tarOctal(header, 116, 8, 0)
  tarOctal(header, 124, 12, entry.content.length)
  tarOctal(header, 136, 12, TAR_TIMESTAMP)
  header.fill(0x20, 148, 156)
  tarField(header, 156, 1, "0")
  tarField(header, 257, 6, "ustar\0")
  tarField(header, 263, 2, "00")
  tarField(header, 265, 32, "root")
  tarField(header, 297, 32, "root")
  tarField(header, 345, 155, name.prefix)
  tarField(
    header,
    148,
    8,
    [...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ",
  )
  return [
    header,
    entry.content,
    new Uint8Array((TAR_BLOCK_SIZE - (entry.content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE),
  ]
}

function linuxArchive(entries: ArchiveEntry[]) {
  const chunks = [...entries.flatMap(tarEntry), new Uint8Array(TAR_BLOCK_SIZE * 2)]
  const archive = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    archive.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return gzipSync(archive, { level: 9 })
}

export async function bundleMcpRuntimeEntries(bundleDir: string) {
  if (
    !(await Promise.all(MCP_RUNTIME_ENTRYPOINTS.map(([, file]) => Bun.file(path.join(bundleDir, file)).exists()))).every(
      Boolean,
    )
  ) {
    return []
  }
  return Promise.all(
    MCP_RUNTIME_ENTRYPOINTS.map(async ([name, file]) => {
      const result = await Bun.build({
        entrypoints: [path.join(bundleDir, file)],
        target: "bun",
        format: "esm",
        minify: true,
      })
      if (!result.success || !result.outputs[0]) {
        throw new Error(`Failed to bundle ${file}: ${result.logs.map((log) => log.message).join("; ")}`)
      }
      return {
        name: `${BUNDLE_PREFIX}/runtime/${name}`,
        content: new Uint8Array(await result.outputs[0].arrayBuffer()),
        mode: 0o644,
      }
    }),
  )
}

async function bundleEntries(bundleDir?: string) {
  if (!bundleDir || !(await Bun.file(path.join(bundleDir, "mimocode.defaults.jsonc")).exists())) return []
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: bundleDir, dot: true, onlyFiles: true })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment)))
    .filter((file) => !EXCLUDED_DOCS.has(file))
    .filter((file) => {
      const base = path.posix.basename(file).toLowerCase()
      if (base === ".env" || (base.startsWith(".env.") && !base.endsWith(".example") && !base.endsWith(".sample"))) {
        return false
      }
      if (base.includes(".test.") || base.includes(".spec.") || base.startsWith("test_") || base.endsWith("_test.py")) {
        return false
      }
      return !base.endsWith(".pem") && !base.endsWith(".key") && !base.includes("credentials")
    })
    .sort()
  const runtime = await bundleMcpRuntimeEntries(bundleDir)
  const entries = await Promise.all(
    files.map(async (file) => ({
      name: `${BUNDLE_PREFIX}/${file}`,
      content:
        file === "mimocode.defaults.jsonc" && runtime.length > 0
          ? new TextEncoder().encode(
              (await Bun.file(path.join(bundleDir, file)).text())
                .replace("vendor/pentesterflow/pentestercode-mcp.ts", "runtime/pentesterflow-core.js")
                .replace("vendor/pentesterflow/src/browser/mcpServer.ts", "runtime/pentesterflow-burp.js")
                .replace("vendor/pentesterflow/bugcrowd-mcp.ts", "runtime/bugcrowd-mcp.js")
                .replace("vendor/pentesterflow/intigriti-mcp.ts", "runtime/intigriti-mcp.js")
                .replace("vendor/pentesterflow/hackerone-mcp.ts", "runtime/hackerone-mcp.js")
                .replace("fusion/fusion-mcp.ts", "runtime/pentestercode-fusion.js"),
            )
          : await Bun.file(path.join(bundleDir, file)).bytes(),
      mode: file.endsWith(".sh") || file === "script/seed-home.ts" ? 0o755 : 0o644,
    })),
  )
  const personal = new TextEncoder().encode("C:\\Users\\victo")
  if (
    [...entries, ...runtime].some((entry) =>
      entry.content.some((_, index) => personal.every((byte, offset) => entry.content[index + offset] === byte)),
    )
  ) {
    throw new Error("PentesterCode bundle contains a developer-specific home path")
  }
  const guide = entries.find((entry) => entry.name === `${BUNDLE_PREFIX}/POST-INSTALL.md`)
  return guide ? [...entries, ...runtime, { ...guide, name: "README-PENTESTERCODE.md" }] : [...entries, ...runtime]
}

export async function packageTarget(input: {
  target: string
  binary: string
  installer: string
  outputDir: string
  bundleDir?: string
}) {
  await fs.mkdir(input.outputDir, { recursive: true })
  const bundle = await bundleEntries(input.bundleDir)
  if (input.target.includes("windows")) {
    const output = path.join(input.outputDir, `${input.target}.zip`)
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add("mimo.exe", new Uint8ArrayReader(await Bun.file(input.binary).bytes()))
    await writer.add("install.ps1", new Uint8ArrayReader(await Bun.file(input.installer).bytes()))
    await Promise.all(bundle.map((entry) => writer.add(entry.name, new Uint8ArrayReader(entry.content))))
    await Bun.write(output, await writer.close())
    return output
  }
  if (!input.target.includes("linux")) throw new Error(`Unsupported installer target: ${input.target}`)

  const output = path.join(input.outputDir, `${input.target}.tar.gz`)
  await Bun.write(
    output,
    linuxArchive([
      { name: "mimo", content: await Bun.file(input.binary).bytes(), mode: 0o755 },
      { name: "install", content: await Bun.file(input.installer).bytes(), mode: 0o755 },
      ...bundle,
    ]),
  )
  return output
}

export async function packageBuiltTargets(input: { targets: string[]; distDir: string; projectRoot: string }) {
  const outputs = await Promise.all(
    input.targets
      .filter((target) => target.includes("windows") || target.includes("linux"))
      .map(async (target) => {
        const windows = target.includes("windows")
        const preferred = path.join(input.distDir, target, "bin", windows ? "mimo.exe" : "mimo")
        const binary = (await Bun.file(preferred).exists()) ? preferred : path.join(input.distDir, target, "bin", "mimo")
        return packageTarget({
          target,
          binary,
          installer: path.join(input.projectRoot, windows ? "install.ps1" : "install"),
          outputDir: input.distDir,
          bundleDir: path.join(input.projectRoot, "packages", "pentestercode"),
        })
      }),
  )
  const linux = outputs.filter((output) => output.endsWith(".tar.gz")).sort()
  if (linux.length === 0) return outputs
  await Bun.write(
    path.join(input.distDir, "SHA256SUMS-linux.txt"),
    (
      await Promise.all(
        linux.map(async (output) => {
          const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(output).bytes()).digest("hex")
          return `${hash}  ${path.basename(output)}`
        }),
      )
    ).join("\n") + "\n",
  )
  await Bun.write(
    path.join(input.distDir, "INSTALL-LINUX.txt"),
    [
      "MiMoCode + PentesterCode - Linux",
      "",
      "Pacotes:",
      "- x86_64 comum: mimocode-linux-x64.tar.gz",
      "- x86_64 sem AVX2: mimocode-linux-x64-baseline.tar.gz",
      "- Alpine x86_64: mimocode-linux-x64-musl.tar.gz",
      "- Alpine x86_64 sem AVX2: mimocode-linux-x64-baseline-musl.tar.gz",
      "- ARM64: mimocode-linux-arm64.tar.gz",
      "- Alpine ARM64: mimocode-linux-arm64-musl.tar.gz",
      "",
      "Entre na pasta para a qual os arquivos foram transferidos:",
      "  cd /diretorio/onde/os-arquivos-foram-copiados",
      "  ls -lh SHA256SUMS-linux.txt mimocode-linux-*.tar.gz",
      "",
      "Verifique o arquivo transferido:",
      "  sha256sum -c SHA256SUMS-linux.txt --ignore-missing",
      "",
      "Instale:",
      "  tar -xzf mimocode-linux-x64.tar.gz",
      "  ./install --binary ./mimo",
      '  export PATH="$HOME/.mimocode/bin:$PATH"',
      "  hash -r 2>/dev/null || true",
      "  mimo --version",
      "",
      "O instalador inclui e inicializa packages/pentestercode automaticamente.",
      "Bun e Python 3 sao dependencias obrigatorias dos MCPs/Fusion.",
      "Consulte README-PENTESTERCODE.md depois de extrair o pacote.",
      "",
    ].join("\n"),
  )
  return outputs
}
