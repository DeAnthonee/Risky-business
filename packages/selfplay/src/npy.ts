import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';

/**
 * Minimal NumPy .npy (format 1.0) writer and reader, so the trainer loads exported datasets with `np.load` (and
 * mmap_mode='r' for big ones) without any conversion step. Rows are streamed; the shape is patched into the header
 * on close, which is why the header has a fixed, generous size.
 */
export type Dtype = '<f4' | '<i4' | '<i8';

const HEADER_BYTES = 256;
const FLUSH_BYTES = 8 << 20;

export class NpyWriter {
  private fd: number;
  private rows = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private offset = HEADER_BYTES;

  constructor(
    private path: string,
    private dtype: Dtype,
    /** Shape of one row (empty for a 1-D array). */
    private rowShape: number[],
  ) {
    this.fd = openSync(path, 'w');
    writeSync(this.fd, header(dtype, [0, ...rowShape]), 0, HEADER_BYTES, 0);
  }

  get length(): number {
    return this.rows;
  }

  /** Append whole rows (values.length must be a multiple of the row size). */
  append(values: Float32Array | Int32Array | BigInt64Array): void {
    const rowSize = this.rowShape.reduce((a, b) => a * b, 1);
    if (values.length % rowSize !== 0) throw new Error(`${this.path}: ${values.length} values is not a whole number of rows of ${rowSize}`);
    this.rows += values.length / rowSize;
    const buf = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    this.pending.push(Buffer.from(buf));
    this.pendingBytes += buf.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
  }

  private flush(): void {
    if (!this.pendingBytes) return;
    const all = Buffer.concat(this.pending);
    writeSync(this.fd, all, 0, all.length, this.offset);
    this.offset += all.length;
    this.pending = [];
    this.pendingBytes = 0;
  }

  close(): void {
    this.flush();
    writeSync(this.fd, header(this.dtype, [this.rows, ...this.rowShape]), 0, HEADER_BYTES, 0);
    closeSync(this.fd);
  }
}

function header(dtype: Dtype, shape: number[]): Buffer {
  const dims = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  const dict = `{'descr': '${dtype}', 'fortran_order': False, 'shape': ${dims}, }`;
  const body = dict.padEnd(HEADER_BYTES - 10 - 1, ' ') + '\n';
  if (body.length !== HEADER_BYTES - 10) throw new Error(`npy header too long for shape ${dims}`);
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.write('\x93NUMPY', 0, 'latin1');
  buf[6] = 1;
  buf[7] = 0;
  buf.writeUInt16LE(body.length, 8);
  buf.write(body, 10, 'latin1');
  return buf;
}

/** Read a .npy file written by NpyWriter (or numpy, for these dtypes, C order). For tests and small checks. */
export function readNpy(path: string): { dtype: Dtype; shape: number[]; data: Float32Array | Int32Array | BigInt64Array } {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 6) !== '\x93NUMPY') throw new Error(`${path}: not a .npy file`);
  const len = buf.readUInt16LE(8);
  const dict = buf.toString('latin1', 10, 10 + len);
  const dtype = /'descr': '([^']+)'/.exec(dict)![1] as Dtype;
  const shape = /'shape': \(([^)]*)\)/.exec(dict)![1].split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  const body = buf.subarray(10 + len);
  const copy = new Uint8Array(body).buffer;
  const data = dtype === '<f4' ? new Float32Array(copy) : dtype === '<i4' ? new Int32Array(copy) : new BigInt64Array(copy);
  return { dtype, shape, data };
}
