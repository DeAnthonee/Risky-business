import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';

/**
 * Runs one Delove model off the main thread. Self-play agents answer synchronously, so the main thread posts a job
 * and blocks on `control` (Atomics.wait) until this worker has written the result into shared memory.
 *
 * Two kinds of job:
 * - 'decision': the policy model scores one decision's candidates (logits, then the value in the last slot).
 * - 'values': the batched value model (<model>.value.onnx) rates B positions at once (B values).
 *
 * control[0]: 0 idle, 1 result ready, -1 error (the message goes to `errors`, read with receiveMessageOnPort).
 * control[1]: number of results written.
 */
interface Init {
  modelPath: string;
  valuePath: string | null;
  control: SharedArrayBuffer;
  output: SharedArrayBuffer;
  errors: MessagePort;
}

interface DecisionJob {
  kind: 'decision';
  T: number;
  C: number;
  territory: Float32Array;
  global: Float32Array;
  adj: Float32Array;
  cand: Float32Array;
  candFrom: BigInt64Array;
  candTo: BigInt64Array;
}

interface ValuesJob {
  kind: 'values';
  T: number;
  B: number;
  territory: Float32Array;
  global: Float32Array;
  adj: Float32Array;
}

const { modelPath, valuePath, control, output, errors } = workerData as Init;
const ctl = new Int32Array(control);
const out = new Float32Array(output);

function signal(state: number) {
  Atomics.store(ctl, 0, state);
  Atomics.notify(ctl, 0);
}

const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' };
const policy = ort.InferenceSession.create(modelPath, opts);
const values = valuePath ? ort.InferenceSession.create(valuePath, opts) : null;
Promise.all([policy, values]).then(
  () => signal(1),
  (err) => {
    errors.postMessage(String(err));
    signal(-1);
  },
);

parentPort!.on('message', async (job: DecisionJob | ValuesJob) => {
  try {
    if (job.kind === 'decision') {
      const { T, C } = job;
      const res = await (await policy).run({
        territory: new ort.Tensor('float32', job.territory, [1, T, job.territory.length / T]),
        global: new ort.Tensor('float32', job.global, [1, job.global.length]),
        adj: new ort.Tensor('float32', job.adj, [T, T]),
        cand: new ort.Tensor('float32', job.cand, [C, job.cand.length / C]),
        cand_from: new ort.Tensor('int64', job.candFrom, [C]),
        cand_to: new ort.Tensor('int64', job.candTo, [C]),
      });
      out.set(res.logits.data as Float32Array, 0);
      out[out.length - 1] = (res.value.data as Float32Array)[0];
      Atomics.store(ctl, 1, C);
    } else {
      if (!values) throw new Error('no value model loaded');
      const { T, B } = job;
      const res = await (await values).run({
        territory: new ort.Tensor('float32', job.territory, [B, T, job.territory.length / (B * T)]),
        global: new ort.Tensor('float32', job.global, [B, job.global.length / B]),
        adj: new ort.Tensor('float32', job.adj, [T, T]),
      });
      out.set(res.value.data as Float32Array, 0);
      Atomics.store(ctl, 1, B);
    }
    signal(1);
  } catch (err) {
    errors.postMessage(String(err));
    signal(-1);
  }
});
