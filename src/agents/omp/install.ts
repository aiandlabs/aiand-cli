/**
 * The OMP release the install hint pins (check-dist keeps ci.yml in step).
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const OMP_VERSION = "18.4.4";

const BASE_URL = `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}`;

/**
 * The release asset for this platform, in the naming the release publishes
 * (omp-darwin-arm64, omp-linux-x64, omp-windows-x64.exe, ...).
 */
function ompReleaseAsset(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `omp-darwin-${arch}`;
  if (process.platform === "win32") return `omp-windows-${arch}.exe`;
  return `omp-linux-${arch}`;
}

/**
 * The install hint downloads the release asset directly and checks it
 * against the SHA256SUMS.txt the release publishes, instead of piping the
 * omp.sh installer: pinned bytes, nothing unverified on PATH. Windows has
 * no shell to run the two commands, so its hint names the asset and the
 * checksum file.
 */
function ompInstallCommand(): string {
  const asset = ompReleaseAsset();
  if (process.platform === "win32") {
    return `Download ${BASE_URL}/${asset} and check it against SHA256SUMS.txt`;
  }
  return `curl -fsSLo ${asset} ${BASE_URL}/${asset} && curl -fsSL ${BASE_URL}/SHA256SUMS.txt | grep ' ${asset}$' | sha256sum -c -`;
}

export const OMP_INSTALL = {
  command: ompInstallCommand(),
  url: "https://omp.sh",
};
