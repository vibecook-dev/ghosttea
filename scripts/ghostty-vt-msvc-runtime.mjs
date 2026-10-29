// Reads the C runtime an MSVC static library was compiled for, from the linker
// directives its objects carry.
//
// Every object compiled against the MSVC C++ standard headers records its C
// runtime as `/FAILIFMISMATCH:"RuntimeLibrary=..."` in its `.drectve` section,
// and the linker refuses two different values in one link (LNK2038). A Rust
// target links the dynamic runtime unless it enables `crt-static`, so each
// Windows Ghostty VT target is built for one runtime, and packaging refuses a
// library whose objects say otherwise.

const ARCHIVE_MAGIC = "!<arch>\n";
const MEMBER_HEADER_BYTES = 60;
const SECTION_HEADER_BYTES = 40;
const BIGOBJ_HEADER_BYTES = 56;
const COFF_HEADER_BYTES = 20;

/** The `RuntimeLibrary` value the MSVC headers stamp for each lock runtime. */
export const RUNTIME_STAMPS = { dll: "MD_DynamicRelease", static: "MT_StaticRelease" };

/** Default libraries that belong to the other runtime, by lock runtime. */
const FOREIGN_LIBRARIES = {
  dll: ["libcmt", "libcpmt", "libvcruntime", "libucrt"],
  static: ["msvcrt", "msvcprt", "vcruntime", "ucrt"],
};

function sectionHeaders(object) {
  if (object.length < COFF_HEADER_BYTES) return null;
  // A /bigobj object starts with an anonymous header: Sig1 0, Sig2 0xFFFF.
  if (object.readUInt16LE(0) === 0 && object.readUInt16LE(2) === 0xffff) {
    if (object.length < BIGOBJ_HEADER_BYTES) return null;
    return { offset: BIGOBJ_HEADER_BYTES, count: object.readUInt32LE(44) };
  }
  const optionalHeaderBytes = object.readUInt16LE(16);
  return { offset: COFF_HEADER_BYTES + optionalHeaderBytes, count: object.readUInt16LE(2) };
}

/** The linker directives one COFF object carries, in order. */
export function objectDirectives(object) {
  const headers = sectionHeaders(object);
  if (!headers) return [];
  const directives = [];
  for (let index = 0; index < headers.count; index += 1) {
    const at = headers.offset + index * SECTION_HEADER_BYTES;
    if (at + SECTION_HEADER_BYTES > object.length) break;
    const name = object
      .subarray(at, at + 8)
      .toString("latin1")
      .replace(/\0+$/, "");
    if (name !== ".drectve") continue;
    const size = object.readUInt32LE(at + 16);
    const pointer = object.readUInt32LE(at + 20);
    const text = object.subarray(pointer, pointer + size).toString("latin1");
    directives.push(...(text.match(/(?:"[^"]*"|[^\s"])+/g) ?? []));
  }
  return directives;
}

/** Each object member of an ar archive as `{ name, directives }`. */
export function archiveDirectives(archive) {
  if (archive.subarray(0, ARCHIVE_MAGIC.length).toString("latin1") !== ARCHIVE_MAGIC) {
    throw new Error("not an ar archive");
  }
  const members = [];
  let longNames = Buffer.alloc(0);
  let at = ARCHIVE_MAGIC.length;
  while (at + MEMBER_HEADER_BYTES <= archive.length) {
    const header = archive.subarray(at, at + MEMBER_HEADER_BYTES).toString("latin1");
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`bad archive member size at ${at}`);
    const body = archive.subarray(at + MEMBER_HEADER_BYTES, at + MEMBER_HEADER_BYTES + size);
    let name = header.slice(0, 16).trim();
    if (name === "//") {
      longNames = body;
    } else if (name !== "/") {
      const longName = /^\/(\d+)$/.exec(name);
      if (longName) {
        const start = Number(longName[1]);
        const end = [longNames.indexOf(0, start), longNames.indexOf(10, start)]
          .filter((value) => value >= 0)
          .reduce((first, value) => Math.min(first, value), longNames.length);
        name = longNames.subarray(start, end).toString("latin1").replace(/\/$/, "");
      } else {
        name = name.replace(/\/$/, "");
      }
      members.push({ name, directives: objectDirectives(body) });
    }
    at += MEMBER_HEADER_BYTES + size + (size % 2);
  }
  return members;
}

function stampOf(directive) {
  return /^\/FAILIFMISMATCH:"?RuntimeLibrary=([^"]+)"?$/i.exec(directive)?.[1] ?? null;
}

function defaultLibraryOf(directive) {
  const library = /^[/-]DEFAULTLIB:"?([^"]+?)"?$/i.exec(directive)?.[1];
  return library ? library.toLowerCase().replace(/\.lib$/, "") : null;
}

/**
 * The problems that keep `archive` from being a library for `runtime` ("dll" or
 * "static"): an object stamped for the other runtime, a default library of the
 * other runtime, or no stamp at all, which would mean this reader saw nothing.
 */
export function msvcRuntimeProblems(archive, runtime) {
  const expected = RUNTIME_STAMPS[runtime];
  if (!expected) throw new Error(`unknown MSVC runtime ${runtime}`);
  const problems = [];
  let stamped = 0;
  for (const member of archiveDirectives(archive)) {
    for (const directive of member.directives) {
      const stamp = stampOf(directive);
      if (stamp !== null) {
        stamped += 1;
        if (stamp !== expected) problems.push(`${member.name} is stamped RuntimeLibrary=${stamp}, not ${expected}`);
      }
      const library = defaultLibraryOf(directive);
      if (library !== null && FOREIGN_LIBRARIES[runtime].includes(library)) {
        problems.push(`${member.name} asks for ${library}.lib, a library of the other C runtime`);
      }
    }
  }
  if (stamped === 0) problems.push(`no object records a RuntimeLibrary stamp; expected ${expected}`);
  return problems;
}
