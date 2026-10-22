import { FEATURE_NAMES } from './features.js';

/**
 * The listening head, v0: logistic regression over the listening features (features.ts), trained supervised on the
 * true roles from talking self-play. It answers p(seat is a Zerg); it never decides moves. A small, exact baseline for
 * the recurrent head the design plans (docs/zergs.md §7); same inputs and target.
 */
export interface ListenerModel {
  version: 1;
  features: readonly string[];
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

export interface Example {
  x: number[];
  y: 0 | 1;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function predict(model: ListenerModel, x: readonly number[]): number {
  let z = model.bias;
  for (let i = 0; i < x.length; i++) z += model.weights[i] * ((x[i] - model.mean[i]) / model.std[i]);
  return sigmoid(z);
}

/** Full-batch gradient descent with L2, on standardised features. Deterministic. */
export function trainListener(data: readonly Example[], epochs = 400, lr = 0.5, l2 = 1e-3, names: readonly string[] = FEATURE_NAMES): ListenerModel {
  const d = names.length;
  const n = Math.max(1, data.length);
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const e of data) for (let i = 0; i < d; i++) mean[i] += e.x[i] / n;
  for (const e of data) for (let i = 0; i < d; i++) std[i] += (e.x[i] - mean[i]) ** 2 / n;
  for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i]) || 1;
  const model: ListenerModel = { version: 1, features: names, mean, std, weights: new Array<number>(d).fill(0), bias: 0 };
  const xs = data.map((e) => e.x.map((v, i) => (v - mean[i]) / std[i]));
  for (let epoch = 0; epoch < epochs; epoch++) {
    const g = new Array<number>(d).fill(0);
    let gb = 0;
    data.forEach((e, k) => {
      let z = model.bias;
      for (let i = 0; i < d; i++) z += model.weights[i] * xs[k][i];
      const err = sigmoid(z) - e.y;
      for (let i = 0; i < d; i++) g[i] += (err * xs[k][i]) / n;
      gb += err / n;
    });
    for (let i = 0; i < d; i++) model.weights[i] -= lr * (g[i] + l2 * model.weights[i]);
    model.bias -= lr * gb;
  }
  return model;
}

/** Area under the ROC curve (Mann-Whitney), ties counted half. 0.5 = chance. */
export function auc(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (pos.length === 0 || neg.length === 0) return NaN;
  const sorted = [...neg].sort((a, b) => a - b);
  let wins = 0;
  for (const p of pos) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    let eq = lo;
    while (eq < sorted.length && sorted[eq] === p) eq++;
    wins += lo + (eq - lo) / 2;
  }
  return wins / (pos.length * neg.length);
}
