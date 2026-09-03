/**
 * Minimal reader for the tar archives GitHub serves from codeload.
 *
 * Handles ustar headers with the prefix field, pax extended headers for
 * long paths, and the pax global header that git archive uses to record the
 * commit id. Links, devices, and other entry types are skipped.
 */

const BLOCK = 512;

const text = (buffer, offset, length) => {
  const end = buffer.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buffer.subarray(offset, stop).toString("utf8");
};

const octal = (buffer, offset, length) => {
  const value = text(buffer, offset, length).trim();
  return value ? parseInt(value, 8) : 0;
};

const isZeroBlock = (block) => block.every((byte) => byte === 0);

/** Parse pax records of the form "<length> <key>=<value>\n". */
export function parsePax(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length).toString("utf8");
    const equals = record.indexOf("=");
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1).replace(/\n$/, "");
    offset += length;
  }
  return records;
}

/**
 * Yield { type, name, data } for every entry. `type` is "file", "directory",
 * or "global" (a pax global header, with its records under `pax`).
 */
export function* readTar(buffer) {
  let offset = 0;
  let pendingPax = null;
  let pendingLongName = null;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;

    const size = octal(header, 124, 12);
    const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const prefix = text(header, 345, 155);
    let name = text(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error("Truncated tar archive");
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "x") {
      pendingPax = parsePax(data);
      continue;
    }
    if (typeflag === "g") {
      yield { type: "global", name, data, pax: parsePax(data) };
      continue;
    }
    // GNU tar stores paths over 100 characters in an "L" entry that describes
    // the entry after it. "K" does the same for a link target, and we skip
    // links, so its payload is discarded.
    if (typeflag === "L") {
      pendingLongName = text(data, 0, data.length);
      continue;
    }
    if (typeflag === "K") continue;

    if (pendingLongName) name = pendingLongName;
    if (pendingPax?.path) name = pendingPax.path;
    pendingLongName = null;
    pendingPax = null;

    if (typeflag === "0" || typeflag === "7") yield { type: "file", name, data };
    else if (typeflag === "5") yield { type: "directory", name, data };
  }
}
