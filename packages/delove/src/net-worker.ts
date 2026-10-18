import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';

/**
 * Runs one Delove ONNX model off the main thread. Self-play agents answer synchronously, so the main thread posts a
 * decision and blocks on `control` (Atomics.wait) until this worker has written the scores into shared memory.
 *
 * control[0]: 0 idle, 1 result ready, -1 error (the message goes to `errors`, read with receiveMessageOnPort).
 * control[1]: candidate count.
 */
interface Init {
  modelPath: string;
  control: SharedArrayBuffer;
  output: SharedArrayBuffer;
  errors: MessagePort;
}

interface Job {
  T: number;
  C: number;
  territory: Float32Array;
  global: Float32Array;
  adj: Float32Array;
  cand: Float32Array;
  candFrom: BigInt64Array;
  candTo: BigInt64Array;
}

const { modelPath, control, output, errors } = workerData as Init;
const ctl = new Int32Array(control);
const out = new Float32Array(output);

function signal(state: number) {
  Atomics.store(ctl, 0, state);
  Atomics.notify(ctl, 0);
}

const session = ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
session.then(
  () => signal(1),
  (err) => {
    errors.postMessage(String(err));
    signal(-1);
  },
);

parentPort!.on('message', async (job: Job) => {
  try {
    const s = await session;
    const { T, C } = job;
    const res = await s.run({
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
    signal(1);
  } catch (err) {
    errors.postMessage(String(err));
    signal(-1);
  }
});
