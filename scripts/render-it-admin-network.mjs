import { writeFileSync } from "node:fs";
import { renderItAdminNetworkGuide } from "../dist/cli/it-admin-network.js";

const guides = [
  ["en", "it-admin-network.md"],
  ["ja", "it-admin-network.ja.md"],
];

for (const [locale, filename] of guides) {
  writeFileSync(
    new URL(`../docs/${filename}`, import.meta.url),
    renderItAdminNetworkGuide(locale),
    "utf8",
  );
}
