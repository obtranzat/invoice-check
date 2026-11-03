/**
 * invoice-check — validate an invoice document and work out its totals offline.
 *
 * Zero dependencies, no network, no clock, no locale formatting, no floating-point money:
 * every amount is an integer number of cents. The same input always produces the same output,
 * so results can be cached, compared in tests and replayed a year later.
 *
 * MIT licensed, (c) Obtranzat.
 */

export type Severity = "error" | "warning" | "info";

/** An error blocks the invoice; a warning is probably a mistake; an info is worth knowing. */
export interface Finding {
  severity: Severity;
  /** Stable machine-readable identifier, e.g. "DUE_BEFORE_ISSUE". Never changes meaning. */
  code: string;
  /** JSON path of the offending value, e.g. "items[2].unitPrice". Empty for whole-document findings. */
  path: string;
  message: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  /** Unit price in cents. Null when the input price was unusable. */
  unitCents: number | null;
  taxRate: number;
  /** Cents excluding tax. */
  netCents: number;
  taxCents: number;
  /** netCents + taxCents. Equals the charged amount under taxMode "inclusive". */
  grossCents: number;
}

export interface InvoiceTotals {
  netCents: number;
  taxCents: number;
  totalCents: number;
  /** net + tax, in major units with two decimals, e.g. "244.00". */
  total: string;
}

export interface TaxComponent {
  rate: number;
  netCents: number;
  taxCents: number;
}

export interface InvoiceCheck {
  /** True when the document has no finding of severity "error". */
  valid: boolean;
  errors: number;
  warnings: number;
  infos: number;
  findings: Finding[];
  invoiceNumber: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  taxMode: "exclusive" | "inclusive";
  taxLabel: string;
  lines: InvoiceLine[];
  /** Null when the lines are too broken to add up. */
  totals: InvoiceTotals | null;
  /** Tax grouped by rate, ascending. */
  taxBreakdown: TaxComponent[];
}

const MAX_LINES = 100;
const MAX_DESCRIPTION = 300;
const MAX_NUMBER = 40;
const MAX_NOTES = 2000;
const LARGE_TOTAL_CENTS = 100_000_000;
const MAX_QUANTITY = 100_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VAT_RE = /^[A-Za-z]{2}[0-9A-Za-z]{2,14}$/;

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return d <= daysInMonth[m - 1];
}

/**
 * An amount in cents, or null when the input is not an amount.
 *
 * Accepts numbers and plain decimal strings. A comma is removed, so it is a thousands
 * separator only: "1,234.50" is one thousand two hundred and thirty-four. Use a dot for
 * the decimal separator; European "1.234,56" is rejected rather than guessed at.
 * Negative amounts are rejected — a credit note is a different document, not a minus sign.
 */
export function parseMoney(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(raw * 100);
  }
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(raw.replace(/,/g, "").trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/**
 * Validate an invoice document and compute its totals.
 *
 * Every problem visible from the input is reported; the walk does not stop at the first
 * error, because the caller is paying attention to what is wrong with the whole document.
 *
 * Expected shape (unknown keys are ignored, so a superset of this is fine):
 *
 * ```json
 * {
 *   "number": "INV-2026-014",
 *   "date": "2026-11-03",
 *   "dueDate": "2026-11-17",
 *   "currency": "EUR",
 *   "taxMode": "exclusive",
 *   "taxLabel": "VAT",
 *   "seller": { "name": "...", "address": "...", "email": "...", "vatId": "..." },
 *   "client": { "name": "...", "vatId": "..." },
 *   "items": [{ "description": "...", "quantity": 4, "unitPrice": "60.00", "taxRate": 25.5 }],
 *   "notes": "..."
 * }
 * ```
 *
 * `from` is accepted for `seller` and `to` or `customer` for `client`. `quantity` defaults to
 * 1, `taxRate` to 0, `currency` to EUR, `taxMode` to exclusive.
 *
 * Under `exclusive` the line price is the net and tax is added on top. Under `inclusive` the
 * line price already contains tax, so the net is derived by dividing by (100 + rate) and the
 * tax is whatever the gross is not. Both modes end on the same gross for the same input.
 */
export function checkInvoice(data: unknown): InvoiceCheck {
  const findings: Finding[] = [];
  const add = (
    severity: Severity,
    code: string,
    path: string,
    message: string,
  ) => findings.push({ severity, code, path, message });

  const empty = (over: Partial<InvoiceCheck> = {}): InvoiceCheck => ({
    valid: false,
    errors: 0,
    warnings: 0,
    infos: 0,
    findings,
    invoiceNumber: "",
    currency: "",
    issueDate: "",
    dueDate: "",
    taxMode: "exclusive",
    taxLabel: "VAT",
    lines: [],
    totals: null,
    taxBreakdown: [],
    ...over,
  });

  if (!isRecord(data)) {
    add("error", "BODY_NOT_OBJECT", "", "invoice must be an object");
    return summarize(empty());
  }

  const seller = isRecord(data.seller) ? data.seller : isRecord(data.from) ? data.from : null;
  const buyer = isRecord(data.client)
    ? data.client
    : isRecord(data.to)
    ? data.to
    : isRecord(data.customer)
    ? data.customer
    : null;

  for (
    const [label, party] of [["seller", seller], ["client", buyer]] as const
  ) {
    if (!party) {
      add("error", "PARTY_MISSING", label, `${label} object is required`);
      continue;
    }
    if (!str(party.name).trim()) {
      add(
        "error",
        "PARTY_NAME_MISSING",
        `${label}.name`,
        `${label}.name is required`,
      );
    }
    const email = str(party.email).trim();
    if (email && !EMAIL_RE.test(email)) {
      add(
        "warning",
        "EMAIL_FORMAT",
        `${label}.email`,
        `${email} is not a valid email address`,
      );
    }
    const vatId = str(party.vatId).replace(/[\s-]/g, "");
    if (vatId && !VAT_RE.test(vatId)) {
      add(
        "info",
        "VAT_ID_FORMAT",
        `${label}.vatId`,
        `${vatId} does not match a common EU or UK VAT number shape`,
      );
    }
  }
  if (seller && buyer) {
    const s = str(seller.name).trim().toLowerCase();
    const b = str(buyer.name).trim().toLowerCase();
    if (s && b && s === b) {
      add(
        "warning",
        "PARTY_SAME",
        "seller.name",
        "seller and client have the same name",
      );
    }
  }

  const currency = (str(data.currency).trim() || "EUR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    add(
      "error",
      "CURRENCY_INVALID",
      "currency",
      "currency must be a 3-letter ISO 4217 code",
    );
  }

  const invoiceNumber = str(data.number).trim();
  if (!invoiceNumber) {
    add("error", "NUMBER_MISSING", "number", "invoice number is required");
  } else if (invoiceNumber.length > MAX_NUMBER) {
    add(
      "warning",
      "NUMBER_LONG",
      "number",
      `invoice number is longer than ${MAX_NUMBER} characters`,
    );
  }

  const issueDate = str(data.date).trim();
  if (!isRealDate(issueDate)) {
    add(
      "error",
      "DATE_INVALID",
      "date",
      "date must be a real calendar date in YYYY-MM-DD",
    );
  }

  const dueDate = str(data.dueDate).trim();
  if (dueDate && !isRealDate(dueDate)) {
    add(
      "error",
      "DUE_DATE_INVALID",
      "dueDate",
      "dueDate must be a real calendar date in YYYY-MM-DD",
    );
  } else if (
    dueDate && issueDate && Date.parse(dueDate) < Date.parse(issueDate)
  ) {
    add(
      "warning",
      "DUE_BEFORE_ISSUE",
      "dueDate",
      "dueDate is earlier than the issue date",
    );
  }

  const rawItems = Array.isArray(data.items) ? data.items : null;
  if (!rawItems || rawItems.length === 0 || rawItems.length > MAX_LINES) {
    add(
      "error",
      "ITEMS_RANGE",
      "items",
      `items must be an array of 1 to ${MAX_LINES} entries`,
    );
  }

  const rawMode = str(data.taxMode).trim().toLowerCase();
  const inclusive = rawMode === "inclusive";
  if (rawMode && rawMode !== "exclusive" && rawMode !== "inclusive") {
    add(
      "warning",
      "TAX_MODE_UNKNOWN",
      "taxMode",
      "taxMode must be exclusive or inclusive; treated as exclusive",
    );
  }
  const taxLabel = (str(data.taxLabel).trim() || "VAT").slice(0, 20);
  const notes = str(data.notes);
  if (notes.length > MAX_NOTES) {
    add(
      "info",
      "NOTES_LONG",
      "notes",
      `notes are longer than ${MAX_NOTES} characters and would be truncated by a renderer`,
    );
  }

  const lines: InvoiceLine[] = [];
  const seen = new Map<string, number>();
  let usable = rawItems !== null && rawItems.length > 0 &&
    rawItems.length <= MAX_LINES;

  (rawItems ?? []).forEach((raw, i) => {
    const at = `items[${i}]`;
    if (!isRecord(raw)) {
      add("error", "ITEM_NOT_OBJECT", at, "each item must be an object");
      usable = false;
      return;
    }

    const description = str(raw.description).trim();
    if (!description) {
      add(
        "error",
        "ITEM_DESCRIPTION_MISSING",
        `${at}.description`,
        "description is required",
      );
      usable = false;
    } else if (description.length > MAX_DESCRIPTION) {
      add(
        "error",
        "ITEM_DESCRIPTION_LONG",
        `${at}.description`,
        `description is longer than ${MAX_DESCRIPTION} characters`,
      );
      usable = false;
    } else {
      const key = description.toLowerCase();
      const first = seen.get(key);
      if (first !== undefined) {
        add(
          "warning",
          "DUPLICATE_LINE",
          at,
          `same description as items[${first}]`,
        );
      } else seen.set(key, i);
    }

    const qtyRaw = raw.quantity ?? 1;
    const qty = typeof qtyRaw === "number" ? qtyRaw : Number(str(qtyRaw));
    if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QUANTITY) {
      add(
        "error",
        "ITEM_QUANTITY_INVALID",
        `${at}.quantity`,
        `quantity must be a number between 0 and ${MAX_QUANTITY}`,
      );
      usable = false;
    }

    let unitCents = parseMoney(raw.unitPrice);
    if (unitCents === null) {
      add(
        "error",
        "ITEM_PRICE_INVALID",
        `${at}.unitPrice`,
        "unitPrice must be a non-negative amount with at most 2 decimals",
      );
      usable = false;
    } else {
      if (
        typeof raw.unitPrice === "number" &&
        Math.round(raw.unitPrice * 100) !== raw.unitPrice * 100
      ) {
        add(
          "warning",
          "ITEM_PRICE_SUBCENT",
          `${at}.unitPrice`,
          "unitPrice has more than 2 decimals and was rounded to cents",
        );
      }
      if (unitCents === 0) {
        add(
          "info",
          "ITEM_ZERO_PRICE",
          `${at}.unitPrice`,
          "line has a zero price",
        );
      }
    }

    const rateRaw = raw.taxRate ?? 0;
    const rate = typeof rateRaw === "number" ? rateRaw : Number(str(rateRaw));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      add(
        "error",
        "ITEM_TAX_RATE_INVALID",
        `${at}.taxRate`,
        "taxRate must be a percentage between 0 and 100",
      );
      usable = false;
    }

    if (
      unitCents === null || !Number.isFinite(qty) || qty <= 0 ||
      !Number.isFinite(rate) || rate < 0
    ) return;

    const gross = Math.round(unitCents * qty);
    if (Math.abs(gross - unitCents * qty) > 1e-9) {
      add(
        "info",
        "ITEM_ROUNDING",
        at,
        "quantity x unitPrice does not land on a whole cent; the line was rounded",
      );
    }
    const net = inclusive ? Math.round((gross * 100) / (100 + rate)) : gross;
    const tax = inclusive ? gross - net : Math.round((net * rate) / 100);
    lines.push({
      description,
      quantity: qty,
      unitCents,
      taxRate: rate,
      netCents: net,
      taxCents: tax,
      grossCents: net + tax,
    });
  });

  let totals: InvoiceTotals | null = null;
  const breakdown: TaxComponent[] = [];
  if (usable && lines.length === (rawItems?.length ?? 0)) {
    const netCents = lines.reduce((s, l) => s + l.netCents, 0);
    const taxCents = lines.reduce((s, l) => s + l.taxCents, 0);
    const totalCents = netCents + taxCents;
    totals = {
      netCents,
      taxCents,
      totalCents,
      total: (totalCents / 100).toFixed(2),
    };
    if (totalCents > LARGE_TOTAL_CENTS) {
      add(
        "warning",
        "TOTAL_LARGE",
        "",
        "invoice total is above 1,000,000 in major units",
      );
    }

    const byRate = new Map<number, TaxComponent>();
    for (const l of lines) {
      const c = byRate.get(l.taxRate) ??
        { rate: l.taxRate, netCents: 0, taxCents: 0 };
      c.netCents += l.netCents;
      c.taxCents += l.taxCents;
      byRate.set(l.taxRate, c);
    }
    for (const c of byRate.values()) breakdown.push(c);
    breakdown.sort((a, b) => a.rate - b.rate);
  }

  return summarize(empty({
    invoiceNumber,
    currency,
    issueDate,
    dueDate,
    taxMode: inclusive ? "inclusive" : "exclusive",
    taxLabel,
    lines,
    totals,
    taxBreakdown: breakdown,
  }));
}

/** {@link checkInvoice} on a JSON string, with the parse failure reported as a finding. */
export function checkInvoiceJson(text: string): InvoiceCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const finding: Finding = {
      severity: "error",
      code: "JSON_PARSE_FAILED",
      path: "",
      message: `not valid JSON: ${(e as Error).message}`,
    };
    return {
      valid: false,
      errors: 1,
      warnings: 0,
      infos: 0,
      findings: [finding],
      invoiceNumber: "",
      currency: "",
      issueDate: "",
      dueDate: "",
      taxMode: "exclusive",
      taxLabel: "VAT",
      lines: [],
      totals: null,
      taxBreakdown: [],
    };
  }
  return checkInvoice(parsed);
}

function summarize(result: InvoiceCheck): InvoiceCheck {
  const count = (s: Severity) => result.findings.filter((f) => f.severity === s).length;
  return {
    ...result,
    errors: count("error"),
    warnings: count("warning"),
    infos: count("info"),
    valid: result.findings.every((f) => f.severity !== "error"),
  };
}
