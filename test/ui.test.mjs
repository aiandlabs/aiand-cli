import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

withTestEnv("aiand-ui-test-", (dir) => {
  const home = join(dir, "home");
  const cfg = join(dir, "cfg");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  process.env.AIAND_HOME = home;
  process.env.AIAND_CONFIG_DIR = cfg;
});

const { colorsEnabled } = await import("../dist/cli/ui/color.js");
const { printBanner } = await import("../dist/cli/ui/banner.js");
const { BANNER_ART } = await import("../dist/cli/ui/banners/art.js");
const { stripBannerMarkup, normalizeBannerArt } = await import(
  "../dist/cli/ui/banner-render.js"
);
const { hyperlinksEnabled, link } = await import("../dist/cli/links.js");

const cli = (args) => runCli(args, { env: cliEnv({ NO_COLOR: "1" }) });

describe("ui color", () => {
  test("disables color when NO_COLOR is set", () =>
    withEnv({ NO_COLOR: "1" }, () => {
      assert.equal(colorsEnabled({ isTTY: true }), false);
    }));

  test("enables color when FORCE_COLOR is set on a non-tty stream", () =>
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
      assert.equal(colorsEnabled({ isTTY: false }), true);
    }));

  test("disables color on non-tty streams by default", () =>
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
      assert.equal(colorsEnabled({ isTTY: false }), false);
    }));
});

describe("ui banner", () => {
  test("banner art fits within 80 columns", () => {
    assert.ok(BANNER_ART.length > 0);
    for (const line of normalizeBannerArt(BANNER_ART).split("\n")) {
      const width = stripBannerMarkup(line).length;
      assert.ok(width <= 80, `line exceeds 80 cols: ${width} — ${stripBannerMarkup(line)}`);
    }
  });

  test("banner art is the ai& wordmark with brand markup and no tagline", () => {
    const plain = stripBannerMarkup(BANNER_ART);
    assert.match(BANNER_ART, /\{brand\}/);
    assert.match(plain, /█████████/);
    assert.match(plain, /█████░░█████░███/);
    assert.doesNotMatch(plain, /Wire any agent/);
  });

  test("prints plain banner art without ANSI when NO_COLOR is set", () =>
    withEnv({ NO_COLOR: "1", FORCE_COLOR: undefined }, () => {
      const chunks = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        chunks.push(String(chunk));
        return true;
      };
      try {
        printBanner({ version: "0.0.0-test" });
      } finally {
        process.stdout.write = originalWrite;
      }
      const output = chunks.join("");
      assert.match(output, /█████████/);
      assert.match(output, /█████░░█████░███/);
      assert.match(output, /v0\.0\.0-test/);
      assert.doesNotMatch(output, /\x1b\[/);
    }));
});

describe("ui normalize", () => {
  test("strips the shared leading indent, keeping relative indentation", () => {
    assert.equal(normalizeBannerArt("  a\n    b\n"), "a\n  b\n");
  });

  test("turns blank lines into empty strings", () => {
    assert.equal(normalizeBannerArt("a\n\nb\n"), "a\n\nb\n");
  });

  test("keeps relative indentation on art lines after normalize", () => {
    const [first, second] = stripBannerMarkup(normalizeBannerArt(BANNER_ART))
      .split("\n");
    assert.match(first, /^\u2588/);
    assert.ok(second.startsWith("  "), "second line keeps its leading spaces");
  });
});

describe("ui links", () => {
  // Every terminal-sniffing var the link helpers read, cleared unless a test sets it.
  const CLEAR = {
    FORCE_HYPERLINK: undefined,
    TERM_PROGRAM: undefined,
    TERM: undefined,
    WT_SESSION: undefined,
    KONSOLE_VERSION: undefined,
    VTE_VERSION: undefined,
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
  };
  const withTerm = (changes, fn) => withEnv({ ...CLEAR, ...changes }, fn);
  const enabled = (isTTY) => hyperlinksEnabled({ stream: { isTTY }, env: process.env });

  test("hyperlinks disabled off-tty by default", async () => {
    await withTerm({}, () => assert.equal(enabled(false), false));
  });

  test("FORCE_HYPERLINK overrides both ways", async () => {
    await withTerm({ FORCE_HYPERLINK: "1" }, () => assert.equal(enabled(false), true));
    await withTerm({ FORCE_HYPERLINK: "0" }, () => assert.equal(enabled(true), false));
    await withTerm({ FORCE_HYPERLINK: "" }, () => assert.equal(enabled(true), false));
  });

  test("allowlist: WezTerm yes, plain xterm-256color no", async () => {
    await withTerm({ TERM_PROGRAM: "WezTerm", TERM: "xterm-256color" }, () =>
      assert.equal(enabled(true), true)
    );
    await withTerm({ TERM: "xterm-256color" }, () => assert.equal(enabled(true), false));
  });

  test("link returns plain URL off-tty and OSC-8-wrapped on a WezTerm tty", async () => {
    await withTerm({ TERM: "xterm-256color", NO_COLOR: "1" }, () => {
      assert.equal(
        link("https://example.com", { stream: { isTTY: false }, env: process.env }),
        "https://example.com"
      );
    });
    await withTerm({ TERM_PROGRAM: "WezTerm", TERM: "xterm-256color", NO_COLOR: "1" }, () => {
      assert.equal(
        link("https://example.com", { stream: { isTTY: true }, env: process.env }),
        "\x1b]8;;https://example.com\x1b\\https://example.com\x1b]8;;\x1b\\"
      );
    });
  });
});

describe("aiand banner command", () => {
  test("prints banner art (hidden command, not in help)", async () => {
    const { code, stdout } = await cli(["banner"]);
    assert.equal(code, 0);
    assert.match(stdout, /█████████/);
    assert.match(stdout, /█████░░█████░███/);
  });

  test("is not listed in aiand help", async () => {
    const { code, stdout } = await cli(["help"]);
    assert.equal(code, 0);
    assert.match(stdout, /█████░░█████░███/);
    // The Commands section must not advertise the hidden banner verb.
    const commandsBlock = stdout.slice(stdout.indexOf("Commands"));
    assert.doesNotMatch(commandsBlock, /^\s*banner\b/m);
  });

  test("bare --help includes the banner", async () => {
    const { code, stdout } = await cli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /█████░░█████░███/);
    assert.match(stdout, /the ai& command line interface/);
  });

  test("--version does not print the banner", async () => {
    const { code, stdout } = await cli(["--version"]);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /█████░░█████░███/);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  });
});
