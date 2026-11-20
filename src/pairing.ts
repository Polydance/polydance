/**
 * What the receiver and `polycap connect` share about connecting an agent (docs/THREADS.md "Connecting your own
 * agent", 2026-11-20): the one-time code a device shows and a person types. Eight characters from 32 that cannot
 * be mistaken for one another (no 0, 1, I or O), 40 bits, shown in two fours: K7QF-2MXD.
 */
import { z } from 'zod';

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE = /^[2-9A-HJ-NP-Z]{8}$/;

/** A code as typed: any case, with or without the dash or spaces. */
export const normalCode = (typed: string) => typed.toUpperCase().replace(/[\s-]/g, '');
/** A code as shown. */
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export const codeSchema = z.string().max(40).transform(normalCode).pipe(z.string().regex(CODE, 'a code is 8 letters and digits, as the headset shows it (K7QF-2MXD)'));
/** What an agent's machine is called, "Mac": no control characters, nothing that could pass for markup. */
export const agentLabelSchema = z.string().transform(s => s.replace(/[\p{C}<>]/gu, '').trim()).pipe(z.string().min(1).max(40));
