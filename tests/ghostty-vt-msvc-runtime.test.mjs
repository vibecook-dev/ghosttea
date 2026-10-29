import assert from "node:assert/strict";
import test from "node:test";
import { archiveDirectives, msvcRuntimeProblems } from "../scripts/ghostty-vt-msvc-runtime.mjs";

// A COFF object whose only section is `.drectve`, in the plain or /bigobj form.
function object(directives, { bigobj = false } = {}) {
  const text = Buffer.from(`${directives.join(" ")} `, "latin1");
  const headerBytes = bigobj ? 56 : 20;
  const header = Buffer.alloc(headerBytes);
  if (bigobj) {
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(0xffff, 2);
    header.writeUInt16LE(2, 4);
    header.writeUInt16LE(0x8664, 6);
    header.writeUInt32LE(1, 44);
  } else {
    header.writeUInt16LE(0x8664, 0);
    header.writeUInt16LE(1, 2);
  }
  const section = Buffer.alloc(40);
  section.write(".drectve", 0, "latin1");
  section.writeUInt32LE(text.length, 16);
  section.writeUInt32LE(headerBytes + 40, 20);
  return Buffer.concat([header, section, text]);
}

function member(name, body) {
  const header = Buffer.alloc(60, " ");
  header.write(name, 0, "latin1");
  header.write("0", 16, "latin1");
  header.write(String(body.length), 48, "latin1");
  header.write("`\n", 58, "latin1");
  return Buffer.concat([header, body, body.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
}

// An MSVC-style archive: a linker member, a long-name table, then objects.
function archive(objects) {
  const longNames = Buffer.from(`${objects.map(([name]) => name).join("\0")}\0`, "latin1");
  let offset = 0;
  const members = objects.map(([name, body]) => {
    const entry = member(`/${offset}`, body);
    offset += Buffer.byteLength(name, "latin1") + 1;
    return entry;
  });
  return Buffer.concat([
    Buffer.from("!<arch>\n", "latin1"),
    member("/", Buffer.alloc(4)),
    member("//", longNames),
    ...members,
  ]);
}

const DYNAMIC = ['/FAILIFMISMATCH:"RuntimeLibrary=MD_DynamicRelease"', "/DEFAULTLIB:msvcprt.lib"];
const STATIC = ['/FAILIFMISMATCH:"RuntimeLibrary=MT_StaticRelease"', "/DEFAULTLIB:libcpmt.lib"];

test("reads the directives of plain and /bigobj objects under long member names", () => {
  const members = archiveDirectives(
    archive([
      ["D:\\build\\cache\\o\\1\\vt.obj", object(DYNAMIC)],
      ["D:\\build\\cache\\o\\2\\ghostty-vt-static_zcu.obj", object(["/alternatename:a=b"], { bigobj: true })],
    ]),
  );
  assert.deepEqual(members, [
    { name: "D:\\build\\cache\\o\\1\\vt.obj", directives: DYNAMIC },
    { name: "D:\\build\\cache\\o\\2\\ghostty-vt-static_zcu.obj", directives: ["/alternatename:a=b"] },
  ]);
});

test("accepts a library whose stamped objects all name its runtime", () => {
  const library = archive([
    ["vt.obj", object(DYNAMIC)],
    ["codepoint_width.obj", object(['/FAILIFMISMATCH:"_CRT_STDIO_ISO_WIDE_SPECIFIERS=0"'])],
  ]);
  assert.deepEqual(msvcRuntimeProblems(library, "dll"), []);
  assert.deepEqual(msvcRuntimeProblems(archive([["vt.obj", object(STATIC)]]), "static"), []);
});

test("names every object stamped for, or asking for a library of, the other runtime", () => {
  const library = archive([
    ["base64.obj", object(STATIC)],
    ["vt.obj", object(DYNAMIC)],
  ]);
  assert.deepEqual(msvcRuntimeProblems(library, "dll"), [
    "base64.obj is stamped RuntimeLibrary=MT_StaticRelease, not MD_DynamicRelease",
    "base64.obj asks for libcpmt.lib, a library of the other C runtime",
  ]);
  assert.deepEqual(msvcRuntimeProblems(library, "static"), [
    "vt.obj is stamped RuntimeLibrary=MD_DynamicRelease, not MT_StaticRelease",
    "vt.obj asks for msvcprt.lib, a library of the other C runtime",
  ]);
});

test("refuses a library in which no object records a stamp, since that reads as nothing seen", () => {
  assert.deepEqual(msvcRuntimeProblems(archive([["abort.obj", object([])]]), "dll"), [
    "no object records a RuntimeLibrary stamp; expected MD_DynamicRelease",
  ]);
});

test("requires a stamped witness for every independently compiled C++ group", () => {
  const required = ["ghosttea-msvc-simd.obj", "ghosttea-msvc-simdutf.obj", "ghosttea-msvc-highway.obj"];
  const complete = required.map((name) => [`D:\\build\\${name}`, object(DYNAMIC)]);
  assert.deepEqual(msvcRuntimeProblems(archive(complete), "dll", required), []);
  assert.deepEqual(msvcRuntimeProblems(archive(complete.slice(0, 2)), "dll", required), [
    "missing stamped runtime witness ghosttea-msvc-highway.obj",
  ]);
  complete[2] = [required[2], object(STATIC)];
  assert.ok(
    msvcRuntimeProblems(archive(complete), "dll", required).some((problem) => problem.includes("MT_StaticRelease")),
  );
});
