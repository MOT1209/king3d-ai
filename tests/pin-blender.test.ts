import { describe, expect, it } from "vitest";
import { buildRelease, parseChecksums, TARGETS, versionsInListing } from "../scripts/pin-blender.ts";

// The checksum text follows `sha256sum` output ("<hash>  <file>"), which is what Blender
// publishes. The hashes below are made up for the test; real ones come only from blender.org.
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const checksumFile = (v: string) => `${H1}  blender-${v}-windows-x64.zip\n${H2}  blender-${v}-linux-x64.tar.xz\n${"c".repeat(64)}  blender-${v}-macos-arm64.dmg\n`;

const listing = (versions: string[], skip: string[] = []) =>
  versions
    .flatMap((v) => Object.values(TARGETS).map((name) => name(v)).concat([`blender-${v}-macos-arm64.dmg`]))
    .filter((name) => !skip.includes(name))
    .map((name) => `<a href="${name}">${name}</a>`)
    .join("\n");

describe("versionsInListing", () => {
  it("returns versions numerically, so 4.2.10 is newer than 4.2.9", () => {
    expect(versionsInListing(listing(["4.2.9", "4.2.10", "4.2.1"]), "4.2")).toEqual(["4.2.1", "4.2.9", "4.2.10"]);
  });

  it("skips a version that is missing one of the archives King3D needs", () => {
    const html = listing(["4.2.1", "4.2.2"], ["blender-4.2.2-linux-x64.tar.xz"]);
    expect(versionsInListing(html, "4.2")).toEqual(["4.2.1"]);
  });

  it("ignores other series", () => {
    expect(versionsInListing(listing(["4.1.0", "4.2.0"]), "4.2")).toEqual(["4.2.0"]);
  });
});

describe("parseChecksums", () => {
  it("reads sha256sum-style lines, lower-casing hashes and tolerating a binary-mode marker", () => {
    const parsed = parseChecksums(`${"A".repeat(64)}  one.zip\r\n${"b".repeat(64)} *two.tar.xz\r\nnot a checksum line\n`);
    expect(parsed.get("one.zip")).toBe("a".repeat(64));
    expect(parsed.get("two.tar.xz")).toBe("b".repeat(64));
    expect(parsed.size).toBe(2);
  });

  it("rejects truncated hashes", () => {
    expect(parseChecksums(`${"a".repeat(63)}  x.zip\n`).size).toBe(0);
  });
});

describe("buildRelease", () => {
  it("builds https URLs and takes hashes only from the checksum file", () => {
    const release = buildRelease("4.2.3", "4.2", parseChecksums(checksumFile("4.2.3")), { "win32-x64": 1000 });
    expect(release.version).toBe("4.2.3");
    expect(release.files["win32-x64"]).toEqual({
      url: "https://download.blender.org/release/Blender4.2/blender-4.2.3-windows-x64.zip",
      sha256: H1,
      size: 1000,
    });
    expect(release.files["linux-x64"]?.sha256).toBe(H2);
    expect(Object.keys(release.files).sort()).toEqual(["linux-x64", "win32-x64"]);
  });

  it("refuses to pin when the checksum file lacks one of the archives", () => {
    const partial = new Map([["blender-4.2.3-windows-x64.zip", H1]]);
    expect(() => buildRelease("4.2.3", "4.2", partial)).toThrow(/refusing to pin without a hash/);
  });
});
