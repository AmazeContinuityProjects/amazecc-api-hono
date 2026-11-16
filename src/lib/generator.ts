/**
 * app-wide deterministic generator keyed by a single manually-set env var.
 *
 * Every hash/generator in the AmazeCC API should go through this module so
 * that:
 *   1. The same input always produces the same output (deterministic),
 *   2. Rotating/migrating servers does not change the math — only the key
 *      does, and the key is set by you, not generated per-server,
 *   3. One place to audit the construction.
 *
 * The key must be set in the environment as GENERATOR_KEY. It is not derived,
 * not random, not per-deploy. If you change it, every previously-generated
 * hash becomes invalid — that is by design (it forces a recount).
 */
import { createHmac } from "node:crypto";

const KEY = process.env.GENERATOR_KEY;

if (!KEY) {
  throw new Error(
    "GENERATOR_KEY is not set. Set GENERATOR_KEY in the environment before starting the worker.",
  );
}

const GENERATOR_KEY: string = KEY;

/**
 * Deterministic keyed hash of an arbitrary string.
 *
 * Output is full-length hex (no truncation) so the collision risk is
 * negligible and the output can be used as a token, a salt, or an
 * identifier without ambiguity.
 */
export function hash(input: string): string {
  return createHmac("sha256", GENERATOR_KEY).update(input).digest("hex");
}

/**
 * Deterministic keyed hash of a mark (0-100), with fixed formatting so
 * that 80, 80.0 and 8e1 all hash identically.
 */
export function hashMark(mark: number): string {
  return hash(`mk::${mark.toFixed(6)}`);
}

/**
 * RegNo-based identity hash: the stable pseudonym for a student, derived
 * from their VTOP register number. No masking, no truncation — reg_no is
 * stored plaintext in student_profiles; this hash is used only where a
 * fixed-length identifier is needed (e.g. class_user_marks.user_key).
 */
export function identityHash(regNo: string): string {
  return hash(`id::${regNo.trim().toUpperCase()}`);
}

/**
 * Assessment keys are keyed like every other generated identifier. The stats
 * response includes assessment metadata so clients can join opaque keys
 * without receiving or reproducing GENERATOR_KEY.
 */
export function assessmentKey(classId: string, component: string, title: string): string {
  const normalised = title.trim().replace(/\s+/g, " ");
  return hash(`as::${classId}::${component}::${normalised}`).slice(0, 32);
}
