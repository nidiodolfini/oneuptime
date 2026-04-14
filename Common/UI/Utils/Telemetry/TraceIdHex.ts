/**
 * OTLP trace IDs (16 bytes) and span IDs (8 bytes) come back from the
 * ClickHouse-backed API as Buffer-like objects (`{type:"Buffer", data:number[]}`)
 * when the backend does not convert them before serializing. Calling
 * `.toString()` on such values in the browser produces `"[object Object]"`
 * (or, for Uint8Array, a comma-separated list of bytes), which then gets
 * embedded into URLs like `/traces/view/[object Object]`, throwing
 * `BadDataException: Invalid route` and blanking the Traces page.
 *
 * This helper normalizes any of the representations we have seen on the
 * wire into lowercase hex (32 chars for trace IDs, 16 chars for span IDs)
 * so downstream code (route params, equality checks, tooltips) can keep
 * treating the value as a plain string.
 */
const toHexId = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    // Backend sometimes JSON-serializes Buffer objects before the SPA gets
    // them, so the field arrives as a literal string like
    // `'{"type":"Buffer","data":[...]}'`. Detect that shape and recurse.
    const trimmed: string = value.trim();
    if (
      trimmed.startsWith('{"type":"Buffer"') ||
      trimmed.startsWith('{"data":')
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return toHexId(parsed);
      } catch {
        // fall through and return raw string
      }
    }
    return value;
  }
  if (typeof value === "object") {
    const maybeBuf: { data?: ArrayLike<number>; type?: string } = value as {
      data?: ArrayLike<number>;
      type?: string;
    };
    if (
      maybeBuf.data &&
      typeof (maybeBuf.data as ArrayLike<number>).length === "number"
    ) {
      const bytes: ArrayLike<number> = maybeBuf.data;
      let hex: string = "";
      for (let i: number = 0; i < bytes.length; i++) {
        hex += (bytes[i]! & 0xff).toString(16).padStart(2, "0");
      }
      return hex;
    }
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      const view: Uint8Array = new Uint8Array(
        (value as ArrayBufferView).buffer,
        (value as ArrayBufferView).byteOffset,
        (value as ArrayBufferView).byteLength,
      );
      let hex: string = "";
      for (let i: number = 0; i < view.length; i++) {
        hex += view[i]!.toString(16).padStart(2, "0");
      }
      return hex;
    }
  }
  return String(value);
};

export default toHexId;
