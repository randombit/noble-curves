/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
// Poseidon Hash: https://eprint.iacr.org/2019/458.pdf, https://www.poseidon-hash.info
import { IField, FpPow, validateField } from './modular.js';
// We don't provide any constants, since different implementations use different constants.
// For reference constants see './test/poseidon.test.js'.
export type PoseidonOpts = {
  Fp: IField<bigint>;
  t: number;
  roundsFull: number;
  roundsPartial: number;
  sboxPower?: number;
  reversePartialPowIdx?: boolean; // Hack for stark
  mds: bigint[][];
  roundConstants: bigint[][];
};

export function validateOpts(opts: PoseidonOpts) {
  const { Fp } = opts;
  validateField(Fp);
  for (const i of ['t', 'roundsFull', 'roundsPartial'] as const) {
    if (typeof opts[i] !== 'number' || !Number.isSafeInteger(opts[i]))
      throw new Error(`Poseidon: invalid param ${i}=${opts[i]} (${typeof opts[i]})`);
  }
  const rev = opts.reversePartialPowIdx;
  if (rev !== undefined && typeof rev !== 'boolean')
    throw new Error(`Poseidon: invalid param reversePartialPowIdx=${rev}`);
  // Default is 5, but for some reasons stark uses 3
  let { sboxPower } = opts;
  if (sboxPower === undefined) sboxPower = 5;
  if (![3, 5, 7].includes(sboxPower)) throw new Error(`Poseidon wrong sboxPower=${sboxPower}`);

  const _sboxPower = BigInt(sboxPower);
  let sboxFn = (n: bigint) => FpPow(Fp, n, _sboxPower);
  // Unwrapped sbox power for common cases (195->142μs)
  if (sboxPower === 3) sboxFn = (n: bigint) => Fp.mul(Fp.sqrN(n), n);
  else if (sboxPower === 5) sboxFn = (n: bigint) => Fp.mul(Fp.sqrN(Fp.sqrN(n)), n);

  if (opts.roundsFull % 2 !== 0)
    throw new Error(`Poseidon roundsFull is not even: ${opts.roundsFull}`);
  const rounds = opts.roundsFull + opts.roundsPartial;

  if (!Array.isArray(opts.roundConstants) || opts.roundConstants.length !== rounds)
    throw new Error('Poseidon: wrong round constants');
  const roundConstants = opts.roundConstants.map((rc) => {
    if (!Array.isArray(rc) || rc.length !== opts.t)
      throw new Error(`Poseidon wrong round constants: ${rc}`);
    return rc.map((i) => {
      if (typeof i !== 'bigint' || !Fp.isValid(i))
        throw new Error(`Poseidon wrong round constant=${i}`);
      return Fp.create(i);
    });
  });
  // MDS is TxT matrix
  if (!Array.isArray(opts.mds) || opts.mds.length !== opts.t)
    throw new Error('Poseidon: wrong MDS matrix');
  const mds = opts.mds.map((mdsRow) => {
    if (!Array.isArray(mdsRow) || mdsRow.length !== opts.t)
      throw new Error(`Poseidon MDS matrix row: ${mdsRow}`);
    return mdsRow.map((i) => {
      if (typeof i !== 'bigint') throw new Error(`Poseidon MDS matrix value=${i}`);
      return Fp.create(i);
    });
  });
  return Object.freeze({ ...opts, rounds, sboxFn, roundConstants, mds });
}

export function splitConstants(rc: bigint[], t: number) {
  if (typeof t !== 'number') throw new Error('poseidonSplitConstants: wrong t');
  if (!Array.isArray(rc) || rc.length % t) throw new Error('poseidonSplitConstants: wrong rc');
  const res = [];
  let tmp = [];
  for (let i = 0; i < rc.length; i++) {
    tmp.push(rc[i]);
    if (tmp.length === t) {
      res.push(tmp);
      tmp = [];
    }
  }
  return res;
}

export function poseidon(opts: PoseidonOpts) {
  const { t, Fp, rounds, sboxFn, reversePartialPowIdx } = validateOpts(opts);
  const halfRoundsFull = Math.floor(opts.roundsFull / 2);
  const partialIdx = reversePartialPowIdx ? t - 1 : 0;
  const poseidonRound = (values: bigint[], isFull: boolean, idx: number) => {
    values = values.map((i, j) => Fp.add(i, opts.roundConstants[idx][j]));

    if (isFull) values = values.map((i) => sboxFn(i));
    else values[partialIdx] = sboxFn(values[partialIdx]);
    // Matrix multiplication
    values = opts.mds.map((i) =>
      i.reduce((acc, i, j) => Fp.add(acc, Fp.mulN(i, values[j])), Fp.ZERO)
    );
    return values;
  };
  const poseidonHash = function poseidonHash(values: bigint[]) {
    if (!Array.isArray(values) || values.length !== t)
      throw new Error(`Poseidon: wrong values (expected array of bigints with length ${t})`);
    values = values.map((i) => {
      if (typeof i !== 'bigint') throw new Error(`Poseidon: wrong value=${i} (${typeof i})`);
      return Fp.create(i);
    });
    let round = 0;
    // Apply r_f/2 full rounds.
    for (let i = 0; i < halfRoundsFull; i++) values = poseidonRound(values, true, round++);
    // Apply r_p partial rounds.
    for (let i = 0; i < opts.roundsPartial; i++) values = poseidonRound(values, false, round++);
    // Apply r_f/2 full rounds.
    for (let i = 0; i < halfRoundsFull; i++) values = poseidonRound(values, true, round++);

    if (round !== rounds)
      throw new Error(`Poseidon: wrong number of rounds: last round=${round}, total=${rounds}`);
    return values;
  };
  // For verification in tests
  poseidonHash.roundConstants = opts.roundConstants;
  return poseidonHash;
}
