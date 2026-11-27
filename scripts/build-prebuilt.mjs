#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";
import { nodeSupportsEnvProxy } from "../dist/cli/proxy.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const NODE_BUILTINS = builtinModules.flatMap((name) =>
  name.startsWith("node:") ? [name] : [name, `node:${name}`],
);

/** The configuration consumed by Node's --experimental-sea-config. */
export function seaConfiguration(main, output, packageJson) {
  return {
    main,
    output,
    assets: { "package.json": packageJson },
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    execArgv: ["--use-env-proxy", "--use-system-ca"],
    execArgvExtension: "none",
  };
}

function codesign(...args) {
  execFileSync("codesign", args, { stdio: "inherit" });
}

/**
 * Build one unsigned, host-platform development executable. The SEA runtime
 * and preparation blob both come from process.execPath's Node installation.
 */
export async function buildPrebuilt(outputDir = join(ROOT, ".scratch", "prebuilt")) {
  if (!nodeSupportsEnvProxy(process.version)) {
    throw new Error(
      `The prebuilt executable requires Node 22.21 or later; got ${process.version}.`,
    );
  }

  const directory = resolve(outputDir);
  const filename = `aiand-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  const artifact = join(directory, filename);
  const bundle = join(directory, `${filename}.bundle.cjs`);
  const configuration = join(directory, `${filename}.sea.json`);
  const blob = join(directory, `${filename}.sea.blob`);

  await mkdir(directory, { recursive: true });
  try {
    await build({
      entryPoints: [join(ROOT, "dist", "index.js")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      external: NODE_BUILTINS,
      banner: {
        js: 'const { pathToFileURL } = require("node:url");\nconst importMetaUrl = pathToFileURL(__filename).href;',
      },
      define: { "import.meta.url": "importMetaUrl" },
    });

    await writeFile(
      configuration,
      JSON.stringify(seaConfiguration(bundle, blob, join(ROOT, "package.json"))),
    );
    // Generate with the same Node executable that is copied below, so the SEA
    // blob format and the injected runtime cannot drift apart.
    execFileSync(process.execPath, ["--experimental-sea-config", configuration], {
      stdio: "inherit",
    });

    await copyFile(process.execPath, artifact);
    await chmod(artifact, 0o755);
    if (process.platform === "darwin") codesign("--remove-signature", artifact);

    // Ad-hoc signing below is only for local macOS execution; this builder is an
    // unsigned development artifact, not a signed installer or release asset.
    await inject(artifact, "NODE_SEA_BLOB", await readFile(blob), {
      sentinelFuse: SEA_SENTINEL,
      ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
    });
    if (process.platform === "darwin") codesign("--sign", "-", artifact);

    return artifact;
  } finally {
    await Promise.all([bundle, configuration, blob].map((path) => rm(path, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildPrebuilt(process.argv[2])
    .then((artifact) => console.log(artifact))
    .catch((error) => {
      console.error(`build-prebuilt: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
