/**
 * Text the agent reads from outside (emails, case notes, cardholder statements, merchant pages)
 * is data, never instructions. The model only turns it into fields of a fixed shape, code makes
 * every money decision, and only a person approves through the approval channel. This screen
 * flags text that tries to instruct the agent anyway, so the run can show it and the audit log
 * can record it. Flagging changes nothing about what the agent may do: nothing in the text can.
 */
const PATTERNS: [RegExp, string][] = [
  [/\bignore (all |any |your |the )?(previous|prior|above|earlier)? ?(instructions|rules|policy|policies)\b/i, "tells the agent to ignore its rules"],
  [/\b(note|message|instruction)s? (to|for) (any |the )?(ai|agent|assistant|model|llm)\b/i, "addresses the AI agent directly"],
  [/\b(system prompt|you are now|act as|as an ai)\b/i, "tries to change the agent's role"],
  [/\b(approved|authori[sz]ed) by (the )?(operator|admin|manager|finance|a person)\b/i, "claims an approval that only a person can give"],
  [/\b(send|transfer|wire|pay|refund)\b[^\n]{0,80}?\b(to|into) (iban|account|wallet|card|routing)\b/i, "asks for money to go to an account named in the text"],
  [/\b(accept|approve|close|refund) (this|the|all) (dispute|case|claim|chargeback|payment)s?\b[^.\n]{0,40}\b(immediately|now|without)\b/i, "asks for an action without the normal checks"],
];

export interface InjectionFinding { phrase: string; why: string }

export function screenUntrusted(text: string): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  for (const [re, why] of PATTERNS) {
    const m = text.match(re);
    if (m) out.push({ phrase: m[0], why });
  }
  return out;
}
